// Tools with switches, so each chapter can turn one feature on and measure it.
// The defaults are the finished harness; each switch's other value is what the
// harness looked like before that chapter.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { childEnv, resolveInside, SandboxError, seatbeltProfile, signalGuardProfile } from "./sandbox.js";
import { ToolError, type ToolContext, type ToolSpec } from "./tools.js";

export interface Kit {
  set: "bash" | "files";                 // only bash, or dedicated file tools plus bash
  describe: "terse" | "full";            // one-line descriptions, or descriptions that say when and how
  errors: "raw" | "instructive";         // exception text, or messages that say what to do instead
  clip: "none" | "head" | "headtail";    // what happens to long output
  clipChars: number;
  edit: "write" | "replace";             // whole-file writes only, or exact-string replacement too
  staleness: boolean;                    // refuse edits to files changed since read
  shell: "naive" | "safe" | "sandboxed"; // no group kill; process groups and a clean env; or that inside sandbox-exec
  confine: boolean;                      // resolve paths inside the workspace
  replaceAll?: boolean;                  // edit_file can replace every occurrence (for renames)
  backgroundHint?: boolean;              // bash description says how background processes behave (ch10)
}

export const FULL: Kit = {
  set: "files", describe: "full", errors: "instructive", clip: "headtail", clipChars: 30_000,
  edit: "replace", staleness: true, shell: "safe", confine: true,
};

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function schemaOf(shape: z.ZodObject) {
  const js = z.toJSONSchema(shape) as Record<string, unknown>;
  delete js.$schema;
  return js as { type: "object"; [k: string]: unknown };
}

export function clipText(s: string, k: Kit): string {
  if (k.clip === "none" || s.length <= k.clipChars) return s;
  if (k.clip === "head") return s.slice(0, k.clipChars);
  const half = Math.floor(k.clipChars / 2);
  return `${s.slice(0, half)}\n\n[... ${s.length - 2 * half} characters omitted ...]\n\n${s.slice(-half)}`;
}

export function buildTools(k: Kit): ToolSpec[] {
  const full = k.describe === "full";
  const say = (instructive: string, raw: string) => new ToolError(k.errors === "instructive" ? instructive : raw);
  const where = (ctx: ToolContext, p: string) => {
    if (k.confine) return resolveInside(ctx.root, p);
    return path.resolve(ctx.root, p);
  };

  const ReadFile = z.object({
    path: z.string().describe(full ? "File path relative to the project root." : ""),
    offset: z.number().int().min(1).optional().describe(full ? "First line to return, 1-based. Default 1." : ""),
    limit: z.number().int().min(1).max(4000).optional().describe(full ? "Number of lines. Default 2000." : ""),
  }).strict();
  const readFile: ToolSpec = {
    def: {
      name: "read_file",
      description: full
        ? "Read a text file in the project. Returns lines prefixed with their line numbers and a tab (the prefix is not part of the file). Read a file before changing it."
        : "Read a file.",
      input_schema: schemaOf(ReadFile),
    },
    schema: ReadFile, parallelSafe: true, summary: (i) => `read ${i.path}`,
    async run(i, ctx) {
      const abs = where(ctx, i.path);
      const st = fs.statSync(abs, { throwIfNoEntry: false });
      if (!st) throw say(`No such file: ${i.path}. Use list_files to see which files exist.`, `ENOENT: no such file or directory, open '${abs}'`);
      if (st.isDirectory()) throw say(`${i.path} is a directory. Use list_files to see what is in it.`, `EISDIR: illegal operation on a directory, read`);
      const text = fs.readFileSync(abs, "utf8");
      ctx.seen.set(abs, sha(text));
      const lines = text.split("\n");
      const start = (i.offset ?? 1) - 1;
      const end = Math.min(lines.length, start + (i.limit ?? 2000));
      const body = lines.slice(start, end).map((l, n) => `${String(start + n + 1).padStart(String(end).length)}\t${l}`).join("\n");
      return clipText(body + (end < lines.length ? `\n[${lines.length - end} more lines; continue with offset=${end + 1}]` : ""), k);
    },
  };

  const ListFiles = z.object({ path: z.string().optional().describe(full ? "Directory relative to the project root. Default: the root." : "") }).strict();
  const listFiles: ToolSpec = {
    def: {
      name: "list_files",
      description: full ? "List all files under a directory, recursively, skipping .git and node_modules. Use it first to find your way around the project." : "List files.",
      input_schema: schemaOf(ListFiles),
    },
    schema: ListFiles, parallelSafe: true, summary: (i) => `list ${i.path ?? "."}`,
    async run(i, ctx) {
      const base = where(ctx, i.path ?? ".");
      if (!fs.existsSync(base)) throw say(`No such directory: ${i.path}. Call list_files with no path to see the whole project.`, `ENOENT: no such file or directory, scandir '${base}'`);
      const out: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (e.name === ".git" || e.name === "node_modules") continue;
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f); else out.push(path.relative(ctx.root, f));
        }
      };
      walk(base);
      return clipText(out.join("\n") || "(no files)", k);
    },
  };

  const WriteFile = z.object({ path: z.string(), content: z.string().describe(full ? "The complete new content of the file." : "") }).strict();
  const writeFile: ToolSpec = {
    def: {
      name: "write_file",
      description: full
        ? (k.edit === "replace"
          ? "Create a new file, or replace the whole content of a file you have read. To change part of an existing file, use edit_file instead."
          : "Create a file or replace the whole content of a file. Write the complete file: anything you leave out is deleted.")
        : "Write a file.",
      input_schema: schemaOf(WriteFile),
    },
    schema: WriteFile, parallelSafe: false, summary: (i) => `write ${i.path}`,
    async run(i, ctx) {
      const abs = where(ctx, i.path);
      if (k.staleness && fs.existsSync(abs)) {
        const last = ctx.seen.get(abs);
        if (!last || last !== sha(fs.readFileSync(abs, "utf8")))
          throw say(`${i.path} exists and you have not read its current content. Read it first, then write.`, `refused: stale`);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, i.content);
      ctx.seen.set(abs, sha(i.content));
      return `Wrote ${i.path} (${i.content.split("\n").length} lines).`;
    },
  };

  const EditFile = z.object({
    path: z.string(),
    old_str: z.string().min(1).describe(full ? "Exact text to replace, copied from the file, including indentation. Must occur exactly once." : ""),
    new_str: z.string().describe(full ? "The text to put in its place." : ""),
    ...(k.replaceAll ? { replace_all: z.boolean().optional().describe("Replace every occurrence instead of exactly one, for renaming. Default false.") } : {}),
  }).strict();
  const editFile: ToolSpec = {
    def: {
      name: "edit_file",
      description: full
        ? "Change part of a file you have read: replace one exact occurrence of old_str with new_str. If old_str is not found, or found more than once, nothing changes; copy it exactly from read_file's output (without the line-number prefix) and include enough surrounding lines to make it unique." + (k.replaceAll ? " To rename something everywhere in the file, set replace_all to true." : "")
        : "Edit a file.",
      input_schema: schemaOf(EditFile),
    },
    schema: EditFile, parallelSafe: false, summary: (i) => `edit ${i.path}`,
    async run(i, ctx) {
      const abs = where(ctx, i.path);
      if (!fs.existsSync(abs)) throw say(`No such file: ${i.path}. Use write_file to create a new file.`, `ENOENT`);
      const text = fs.readFileSync(abs, "utf8");
      if (k.staleness) {
        const last = ctx.seen.get(abs);
        if (!last) throw say(`Read ${i.path} with read_file before editing it.`, `refused: not read`);
        if (last !== sha(text)) throw say(`${i.path} changed since you last read it. Read it again, then edit.`, `refused: stale`);
      }
      const count = text.split(i.old_str).length - 1;
      if (count === 0) throw say(`old_str was not found in ${i.path}. Read the file again and copy the text exactly, including indentation, without line-number prefixes.`, `old_str not found`);
      if (count > 1 && k.replaceAll && (i as { replace_all?: boolean }).replace_all) {
        const all = text.split(i.old_str).join(i.new_str);
        fs.writeFileSync(abs, all);
        ctx.seen.set(abs, sha(all));
        return `Edited ${i.path}: replaced ${count} occurrences.`;
      }
      if (count > 1) throw say(`old_str occurs ${count} times in ${i.path}. Include more surrounding lines so it matches exactly once.`, `multiple matches`);
      const next = text.replace(i.old_str, () => i.new_str);
      fs.writeFileSync(abs, next);
      ctx.seen.set(abs, sha(next));
      return `Edited ${i.path}.`;
    },
  };

  const Bash = z.object({
    command: z.string().min(1).describe(full ? "The command to run with /bin/sh in the project root." : ""),
    timeout_ms: z.number().int().min(1000).max(600_000).optional().describe(full ? "Default 120000." : ""),
  }).strict();
  const bash: ToolSpec = {
    def: {
      name: "bash",
      description: full
        ? (k.set === "files"
          ? "Run a shell command in the project root, for running tests, builds and git. Use read_file, list_files, edit_file and write_file for files instead of cat, ls, sed or echo. Each call starts a fresh shell, stdin is closed (interactive programs fail), and the output comes back with the exit code." + (k.backgroundHint ? " A command that doesn't exit, such as a server, is stopped at the timeout, and anything a command starts in the background is stopped when the command finishes. To query a server, start it and query it in the same command: node src/server.js & sleep 1; curl -s localhost:3999/health" : "")
          : "Run a shell command in the project root, with /bin/sh. Each call starts a fresh shell. stdin is closed, so interactive programs fail. Returns the exit code and the combined output.")
        : "Run a shell command.",
      input_schema: schemaOf(Bash),
    },
    schema: Bash, parallelSafe: false, summary: (i) => `bash: ${i.command}`,
    run(i, ctx) {
      if (k.shell === "naive") {
        const r = spawnSync("/bin/sh", ["-c", i.command], { cwd: ctx.root, encoding: "utf8", timeout: i.timeout_ms ?? 120_000 });
        return Promise.resolve(clipText(`[exit code ${r.status ?? r.signal}]\n${r.stdout ?? ""}${r.stderr ?? ""}`, k));
      }
      return new Promise((resolve, reject) => {
        const profile = k.shell === "sandboxed" ? seatbeltProfile(ctx.root) : signalGuardProfile();
        const [cmd, argv] = ["/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", i.command]] as const;
        const child = spawn(cmd, [...argv], { cwd: ctx.root, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
        let out = "";
        const take = (b: Buffer) => { if (out.length < 4 * k.clipChars) out += b.toString("utf8"); };
        child.stdout.on("data", take); child.stderr.on("data", take);
        let why = "";
        const kill = (r: string) => { why = r; try { process.kill(-child.pid!, "SIGTERM"); } catch {} setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 2000).unref(); };
        const ms = i.timeout_ms ?? 120_000;
        const timer = setTimeout(() => kill(`timed out after ${ms} ms`), ms);
        const onAbort = () => kill("cancelled");
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        // When the shell exits but something it started in the background still
        // holds the output pipe, "close" never comes. Give it a moment, then stop
        // the whole group and say so, instead of waiting for the timeout.
        let leftover = false, exitCode: number | null = null;
        child.on("exit", (code) => {
          exitCode = code;
          setTimeout(() => { if (!done) { leftover = true; try { process.kill(-child.pid!, "SIGTERM"); } catch {} } }, 1500).unref();
        });
        let done = false;
        child.on("close", (code, sig) => {
          done = true;
          clearTimeout(timer); ctx.signal.removeEventListener("abort", onAbort);
          const head = why ? `killed: ${why}` : leftover ? `exit code ${exitCode}; background processes it started were stopped when the command finished` : sig ? `killed by ${sig}` : `exit code ${code}`;
          const text = clipText(`[${head}]\n${out}`, k);
          if (why) reject(new ToolError(text)); else resolve(text);
        });
      });
    },
  };

  const tools = k.set === "bash" ? [bash] : [readFile, listFiles, ...(k.edit === "replace" ? [editFile] : []), writeFile, bash];
  return tools;
}

export { SandboxError };
