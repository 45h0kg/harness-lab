// The same first request, sent N times through Ollama's /api/chat (Ollama renders
// the template and parses tool calls) and through RawOllamaModel (the harness does
// both). Counts replies that are empty, that call a tool, or that are only text.
// tsx src/probe-wire.ts [model] [n]
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM as SYSTEM_BARE } from "./bare.js";
import { SYSTEM_FULL } from "./harness.js";
import type { Model } from "./model.js";
import { OllamaModel } from "./ollama.js";
import { RawOllamaModel } from "./raw.js";
import { TASKS } from "./tasks.js";

const modelName = process.argv[2] ?? "qwen2.5:7b";
const N = Number(process.argv[3] ?? 10);
const BASH: Anthropic.Tool = {
  name: "bash", description: "Run a shell command.",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};
const systems: Record<string, string | undefined> = { bare: SYSTEM_BARE, full: SYSTEM_FULL, none: undefined };
const task = TASKS.find((t) => t.id === "fix-tests")!.prompt;

for (const [wire, make] of [["chat", () => new OllamaModel(modelName, { num_ctx: 16384 })], ["raw", () => new RawOllamaModel(modelName, { num_ctx: 16384 })]] as const) {
  for (const [sname, system] of Object.entries(systems)) {
    const m = make() as Model & { last?: { eval_count: number; prompt_eval_count: number; raw?: string } };
    let empty = 0, tool = 0, text = 0, toolWithText = 0, opensWithCall = 0;
    const evals: number[] = []; let ptok = 0;
    for (let i = 0; i < N; i++) {
      const r = await m.send({ model: "", max_tokens: 4096, ...(system ? { system } : {}), tools: [BASH], messages: [{ role: "user", content: task }] });
      evals.push(m.last!.eval_count); ptok = m.last!.prompt_eval_count;
      const hasTool = r.content.some((b) => b.type === "tool_use");
      const hasText = r.content.some((b) => b.type === "text" && b.text.trim());
      if (hasTool) tool++; else if (hasText) text++; else empty++;
      if (hasTool && hasText) toolWithText++;
      if (m.last!.raw?.trimStart().startsWith("<tool_call>") || m.last!.raw?.trimStart().startsWith('{"name"')) opensWithCall++;
    }
    console.log(`${modelName} wire=${wire.padEnd(4)} system=${sname.padEnd(4)}  tool call ${tool}/${N}  text only ${text}/${N}  empty ${empty}/${N}  call+text ${toolWithText}  ${wire === "raw" ? `opens with call ${opensWithCall}  ` : ""}prompt tokens ${ptok}  tokens generated: ${evals.join(",")}`);
  }
}
