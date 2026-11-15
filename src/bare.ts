// Chapter 1: the smallest agent that can work on a repository. One tool, a
// loop, and nothing else. The lab adds two safety limits the design doesn't
// have (a 120 s command timeout and a 40-turn cap) so a bad run can't hang the bench.
import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import type { Agent } from "./agent.js";

export const SYSTEM = "You are a coding assistant working in a software project. You can run shell commands in the project directory with the bash tool.";

const BASH: Anthropic.Tool = {
  name: "bash",
  description: "Run a shell command.",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

export const bareAgent: Agent = async (task, dir, model) => {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  let turns = 0, toolCalls = 0, toolErrors = 0, text = "";
  while (turns < 40) {
    turns++;
    const msg = await model.send({ model: "", max_tokens: 4096, system: SYSTEM, tools: [BASH], messages });
    messages.push({ role: "assistant", content: msg.content });
    text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!calls.length) return { status: "done", text, turns, toolCalls, toolErrors, messages };
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const c of calls) {
      toolCalls++;
      const command = (c.input as { command?: string }).command ?? "";
      const r = spawnSync("/bin/sh", ["-c", command], { cwd: dir, encoding: "utf8", timeout: 120_000 });
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      if (r.status !== 0) toolErrors++;
      results.push({ type: "tool_result", tool_use_id: c.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }
  return { status: "max_turns", text, turns, toolCalls, toolErrors, messages };
};
