// Tool definitions: what the model sees (def), how the harness checks input
// (schema), how it schedules the call (parallelSafe), and what runs (run).
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { childEnv, resolveInside } from "./sandbox.js";

export interface ToolContext {
  root: string;
  signal: AbortSignal;
  // sha256 of each file's content when the model last read or wrote it.
  seen: Map<string, string>;
}

export interface ToolSpec {
  def: Anthropic.Tool;
  schema: z.ZodType;
  parallelSafe: boolean;
  summary(input: any): string; // one line, for permission prompts and logs
  run(input: any, ctx: ToolContext): Promise<string>;
}

// A failed tool call is not an exception to the loop. It becomes a
// tool_result with is_error: true, and the message is written for the model.
export class ToolError extends Error {}

const MAX_OUTPUT_CHARS = 30_000;

// Keep the head and the tail: errors tend to be at the end, context at the start.
export function clip(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  const dropped = s.length - 2 * half;
  return `${s.slice(0, half)}\n\n[... ${dropped} characters omitted ...]\n\n${s.slice(-half)}`;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function schemaOf(shape: z.ZodObject): Anthropic.Tool.InputSchema {
  const js = z.toJSONSchema(shape) as Record<string, unknown>;
  delete js.$schema;
  return js as Anthropic.Tool.InputSchema;
}

// ---------------------------------------------------------------- read_file
const ReadFile = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  offset: z.number().int().min(1).optional().describe("First line to return, 1-based. Default 1."),
  limit: z.number().int().min(1).max(4000).optional().describe("Number of lines. Default 2000."),
}).strict();

export const readFile: ToolSpec = {
  def: {
    name: "read_file",
    description:
      "Read a text file from the workspace. Returns lines prefixed with their line numbers " +
      "(the prefix is not part of the file). Read a file before editing it: edit_file refuses " +
      "files that were not read first or that changed since they were read.",
    input_schema: schemaOf(ReadFile),
  },
  schema: ReadFile,
  parallelSafe: true,
  summary: (i) => `read ${i.path}`,
  async run(i, ctx) {
    const abs = resolveInside(ctx.root, i.path);
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st) throw new ToolError(`No such file: ${i.path}. Use list_files to see what exists.`);
    if (st.isDirectory()) throw new ToolError(`${i.path} is a directory. Use list_files.`);
    if (st.size > 5_000_000) throw new ToolError(`${i.path} is ${st.size} bytes; read it in ranges with offset/limit.`);
    const text = fs.readFileSync(abs, "utf8");
    if (text.includes("\0")) throw new ToolError(`${i.path} looks binary; not shown.`);
    ctx.seen.set(abs, sha(text));
    const lines = text.split("\n");
    const start = (i.offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (i.limit ?? 2000));
    const width = String(end).length;
    const body = lines.slice(start, end).map((l, n) => `${String(start + n + 1).padStart(width)}\t${l}`).join("\n");
    const more = end < lines.length ? `\n[${lines.length - end} more lines; continue with offset=${end + 1}]` : "";
    return clip(body + more);
  },
};

// --------------------------------------------------------------- list_files
const ListFiles = z.object({
  path: z.string().optional().describe("Directory relative to the workspace root. Default '.'."),
}).strict();

export const listFiles: ToolSpec = {
  def: {
    name: "list_files",
    description: "List files under a directory, recursively, skipping .git and node_modules. Use it to find files before reading them.",
    input_schema: schemaOf(ListFiles),
  },
  schema: ListFiles,
  parallelSafe: true,
  summary: (i) => `list ${i.path ?? "."}`,
  async run(i, ctx) {
    const base = resolveInside(ctx.root, i.path ?? ".");
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else out.push(path.relative(ctx.root, full));
        if (out.length >= 1000) return;
      }
    };
    walk(base);
    return out.length ? clip(out.join("\n")) : "(no files)";
  },
};

// ---------------------------------------------------------------- edit_file
const EditFile = z.object({
  path: z.string(),
  old_str: z.string().min(1).describe("Exact text to replace, including whitespace. Must occur exactly once."),
  new_str: z.string().describe("Replacement text."),
}).strict();

export const editFile: ToolSpec = {
  def: {
    name: "edit_file",
    description:
      "Replace one exact occurrence of old_str with new_str in a file you have already read. " +
      "If old_str occurs zero times or more than once the edit is refused; include more " +
      "surrounding lines to make it unique. Do not include read_file's line-number prefixes.",
    input_schema: schemaOf(EditFile),
  },
  schema: EditFile,
  parallelSafe: false,
  summary: (i) => `edit ${i.path}`,
  async run(i, ctx) {
    const abs = resolveInside(ctx.root, i.path);
    if (!fs.existsSync(abs)) throw new ToolError(`No such file: ${i.path}. Use write_file to create it.`);
    const text = fs.readFileSync(abs, "utf8");
    const last = ctx.seen.get(abs);
    if (!last) throw new ToolError(`Read ${i.path} with read_file before editing it.`);
    if (last !== sha(text)) throw new ToolError(`${i.path} changed since you last read it. Read it again, then edit.`);
    const count = text.split(i.old_str).length - 1;
    if (count === 0) throw new ToolError(`old_str was not found in ${i.path}. Check whitespace and indentation against a fresh read.`);
    if (count > 1) throw new ToolError(`old_str occurs ${count} times in ${i.path}. Add surrounding lines so it matches once.`);
    const next = text.replace(i.old_str, () => i.new_str); // function form: no $& surprises
    fs.writeFileSync(abs, next);
    ctx.seen.set(abs, sha(next));
    return `Edited ${i.path}.`;
  },
};

// --------------------------------------------------------------- write_file
const WriteFile = z.object({
  path: z.string(),
  content: z.string().describe("The complete new file content."),
}).strict();

export const writeFile: ToolSpec = {
  def: {
    name: "write_file",
    description: "Create a file, or overwrite one you have read. Prefer edit_file for changes to existing files.",
    input_schema: schemaOf(WriteFile),
    eager_input_streaming: true,
  },
  schema: WriteFile,
  parallelSafe: false,
  summary: (i) => `write ${i.path} (${i.content.length} chars)`,
  async run(i, ctx) {
    const abs = resolveInside(ctx.root, i.path);
    if (fs.existsSync(abs)) {
      const last = ctx.seen.get(abs);
      if (!last || last !== sha(fs.readFileSync(abs, "utf8"))) {
        throw new ToolError(`${i.path} exists and you have not read its current version. Read it first.`);
      }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, i.content);
    fs.renameSync(tmp, abs); // atomic on POSIX: no half-written file on a crash
    ctx.seen.set(abs, sha(i.content));
    return `Wrote ${i.path}.`;
  },
};

// --------------------------------------------------------------------- bash
const Bash = z.object({
  command: z.string().min(1),
  timeout_ms: z.number().int().min(1000).max(600_000).optional().describe("Default 120000."),
}).strict();

export const bash: ToolSpec = {
  def: {
    name: "bash",
    description:
      "Run a shell command in the workspace root with /bin/sh. Each call is a fresh shell: cd " +
      "and exported variables do not persist. stdin is closed, so interactive programs fail. " +
      "Returns the exit code and combined output, clipped in the middle if long.",
    input_schema: schemaOf(Bash),
  },
  schema: Bash,
  parallelSafe: false,
  summary: (i) => `bash: ${i.command}`,
  run(i, ctx) {
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", i.command], {
        cwd: ctx.root,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group, so we can kill grandchildren too
      });
      // Bounded memory however much the command prints: the first HALF
      // characters and a rolling window of the last HALF.
      const HALF = MAX_OUTPUT_CHARS / 2;
      let head = "", tail = "", total = 0, size = 0;
      const take = (b: Buffer) => {
        size += b.length;
        const s = b.toString("utf8");
        total += s.length;
        const room = HALF - head.length;
        if (room > 0) { head += s.slice(0, room); tail += s.slice(room); } else tail += s;
        if (tail.length > HALF) tail = tail.slice(-HALF);
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      let why = "";
      const killGroup = (reason: string) => {
        why = reason;
        try { process.kill(-child.pid!, "SIGTERM"); } catch {}
        setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 2000).unref();
      };
      const timeout = i.timeout_ms ?? 120_000;
      const timer = setTimeout(() => killGroup(`timed out after ${timeout} ms`), timeout);
      const onAbort = () => killGroup("cancelled by the user");
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", (code, sig) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        const status = why ? `killed: ${why}` : sig ? `killed by ${sig}` : `exit code ${code}`;
        const dropped = total - head.length - tail.length;
        const body = dropped > 0 ? `${head}\n\n[... ${dropped} characters omitted ...]\n\n${tail}` : head + tail;
        const text = `[${status}; ${size} bytes of output]\n${body}`;
        // A non-zero exit is a normal answer the model should read. A kill is not.
        if (why) reject(new ToolError(text)); else resolve(text);
      });
    });
  },
};

export const ALL_TOOLS: ToolSpec[] = [readFile, listFiles, editFile, writeFile, bash];
