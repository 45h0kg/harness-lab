// Run agents over the task suite and record every run.
// tsx src/bench.ts --exp NAME --agent bare --model qwen2.5:7b --runs 3 [--tasks a,b] [--ctx 16384]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Agent } from "./agent.js";
import { VARIANTS } from "./variants.js";
import { OllamaModel, type OllamaTimings } from "./ollama.js";
import { RawOllamaModel } from "./raw.js";
import type { Model, Request } from "./model.js";
import { EXTRA_TASKS, TASKS, prepare } from "./tasks.js";

export const AGENTS: Record<string, Agent> = VARIANTS;

const { values: a } = parseArgs({ options: {
  exp: { type: "string" }, agent: { type: "string", default: "bare" }, model: { type: "string", default: "qwen2.5:7b" },
  runs: { type: "string", default: "3" }, tasks: { type: "string" }, ctx: { type: "string", default: "16384" },
  timeout: { type: "string", default: "600" }, wire: { type: "string", default: "chat" },
} });


// Wrap the model to record per-call timings.
class Recorded implements Model {
  calls: OllamaTimings[] = [];
  constructor(private inner: OllamaModel | RawOllamaModel) {}
  async send(req: Request, signal?: AbortSignal) {
    const m = await this.inner.send(req, signal);
    this.calls.push(this.inner.last!);
    return m;
  }
}

const agentName = a.agent!;
const agent = AGENTS[agentName];
if (!agent) throw new Error(`unknown agent ${agentName}`);
const tasks = a.tasks ? [...TASKS, ...EXTRA_TASKS].filter((t) => a.tasks!.split(",").includes(t.id)) : TASKS;
const expDir = path.resolve(import.meta.dirname, "../runs", a.exp!);
fs.mkdirSync(expDir, { recursive: true });
const results = path.join(expDir, "results.jsonl");

for (let n = 1; n <= Number(a.runs); n++) {
  for (const task of tasks) {
    const runDir = path.join(expDir, `${agentName}${a.wire === "raw" ? "-raw" : ""}-${a.model!.replace(/[:/]/g, "_")}`, `${task.id}-${n}`);
    fs.mkdirSync(runDir, { recursive: true });
    const dir = prepare(task, runDir);
    const model = new Recorded(a.wire === "raw" ? new RawOllamaModel(a.model!, { num_ctx: Number(a.ctx) }) : new OllamaModel(a.model!, { num_ctx: Number(a.ctx) }));
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Number(a.timeout) * 1000);
    let run;
    // The signal goes to the agent too, so a run that is out of time stops its loop and
    // its commands instead of running on beside the next run.
    const pending = agent(task.prompt, dir, model, ac.signal);
    try {
      run = await Promise.race([
        pending,
        new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error("wall-clock limit")))),
      ]);
    } catch (e) {
      const late = await Promise.race([pending.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 30_000))]);
      run = { status: "error", text: "", turns: model.calls.length, toolCalls: late?.toolCalls ?? 0, toolErrors: late?.toolErrors ?? 0, messages: late?.messages ?? [], error: (e as Error).message + (late ? "" : "; agent did not stop within 30 s") };
    }
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const check = task.check(dir, run.text);
    task.cleanup?.(dir);
    const rec = {
      exp: a.exp, agent: agentName, model: a.model, task: task.id, run: n, pass: check.pass, why: check.why,
      status: run.status, error: run.error, turns: run.turns, toolCalls: run.toolCalls, toolErrors: run.toolErrors, ms,
      promptTokens: model.calls.reduce((s, c) => s + c.prompt_eval_count, 0),
      cachedTokens: model.calls.reduce((s, c) => s + c.prompt_eval_cached_count, 0),
      outTokens: model.calls.reduce((s, c) => s + c.eval_count, 0),
      maxPrompt: Math.max(0, ...model.calls.map((c) => c.prompt_eval_count)), // prompt_eval_count is the whole prompt; cached is part of it
      promptMs: Math.round(model.calls.reduce((s, c) => s + c.prompt_eval_ms, 0)),
      evalMs: Math.round(model.calls.reduce((s, c) => s + c.eval_ms, 0)),
    };
    fs.writeFileSync(path.join(runDir, "transcript.json"), JSON.stringify({ rec, messages: run.messages, calls: model.calls }, null, 1));
    fs.appendFileSync(results, JSON.stringify(rec) + "\n");
    console.log(`${task.id.padEnd(14)} #${n} ${check.pass ? "PASS" : "fail"}  ${run.status.padEnd(9)} turns=${String(run.turns).padStart(2)} tools=${String(run.toolCalls).padStart(2)} ${(ms / 1000).toFixed(0).padStart(4)}s  ${check.why}`);
  }
}
