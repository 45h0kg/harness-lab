// The agent loop: a state machine over stop_reason.
import Anthropic from "@anthropic-ai/sdk";
import type { Model, Request } from "./model.js";
import { Approver, Policy } from "./permissions.js";
import { SandboxError } from "./sandbox.js";
import { ToolContext, ToolError, ToolSpec, clip } from "./tools.js";
import { Transcript } from "./transcript.js";

export interface Hooks {
  // Runs after the policy allowed the call and before it executes.
  // Return a string to block the call with that message.
  preToolUse?(name: string, input: unknown): Promise<string | void>;
  // Can rewrite what the model sees, e.g. to redact secrets.
  postToolUse?(name: string, input: unknown, result: string, isError: boolean): Promise<string | void>;
}

export interface AgentOptions {
  model: Model;
  modelId: string;
  system: string;
  tools: ToolSpec[];
  root: string;
  policy: Policy;
  approve: Approver;
  transcript: Transcript;
  hooks?: Hooks;
  maxTurns?: number;          // model calls per run
  maxTokens?: number;         // per response
  maxOutputBudget?: number;   // summed output tokens per run
  compactAtInputTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  signal?: AbortSignal;
  log?: (line: string) => void;
  nudges?: number;            // how many times to push back on an ending that did nothing
  repeatGuard?: boolean;      // refuse the third identical call in a row
  // Runs when the model ends its turn. Return a message to send back instead of
  // finishing (facts about the workspace the model should see), or nothing to finish.
  stopCheck?: (root: string) => Promise<string | void>;
  stopChecks?: number;        // how many times stopCheck may send the model back
}

// A tool call written into the text instead of made: {"name": "bash", "parameters": {...}}
export const TEXT_CALL = /\{\s*"name"\s*:\s*"[\w-]+"\s*,\s*"(parameters|arguments|input)"\s*:/;

export type Status = "done" | "done-text-call" | "done-no-action" | "max_turns" | "budget" | "refusal" | "max_tokens" | "cancelled";
export interface RunResult { status: Status; turns: number; text: string; outputTokens: number }

const SUMMARY_PROMPT =
  "Your context is about to be reset. Write a summary that will replace the conversation so far. " +
  "Include: the user's task and every constraint they gave; what is done, with file paths; what " +
  "failed and why; decisions made and their reasons; the exact next step. Do not call tools.";

export async function runAgent(messages: Anthropic.MessageParam[], o: AgentOptions): Promise<RunResult> {
  const log = o.log ?? (() => {});
  const signal = o.signal ?? new AbortController().signal;
  const byName = new Map(o.tools.map((t) => [t.def.name, t]));
  // Sorted, frozen once: the tools array is the first thing in the cached prefix.
  const toolDefs = o.tools.map((t) => t.def).sort((a, b) => a.name.localeCompare(b.name));
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }];
  const ctx: ToolContext = { root: o.root, signal, seen: new Map() };
  const maxTurns = o.maxTurns ?? 50;
  let maxTokens = o.maxTokens ?? 32_000;
  let turns = 0, outputTokens = 0, escalated = false, nudgesLeft = o.nudges ?? 0, callsMade = 0, checksLeft = o.stopChecks ?? 2;
  const recent: string[] = [];

  const push = (m: Anthropic.MessageParam) => { messages.push(m); o.transcript.append({ t: "message", message: m }); };

  const request = (msgs: Anthropic.MessageParam[], extra: Partial<Request> = {}): Request => ({
    model: o.modelId,
    max_tokens: maxTokens,
    system,
    tools: toolDefs,
    messages: msgs,
    thinking: { type: "adaptive" },
    output_config: { effort: o.effort ?? "high" },
    cache_control: { type: "ephemeral" }, // automatic breakpoint on the growing tail
    ...extra,
  });

  while (true) {
    if (signal.aborted) return { status: "cancelled", turns, text: "", outputTokens };
    if (turns >= maxTurns) return { status: "max_turns", turns, text: "", outputTokens };
    if (o.maxOutputBudget && outputTokens >= o.maxOutputBudget) return { status: "budget", turns, text: "", outputTokens };
    turns++;

    const msg = await o.model.send(request(messages), signal);
    outputTokens += msg.usage.output_tokens;
    o.transcript.append({ t: "usage", turn: turns, usage: msg.usage, stop: msg.stop_reason });
    const inputTotal = msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
    log(`turn ${turns}: stop=${msg.stop_reason} in=${inputTotal} (cached ${msg.usage.cache_read_input_tokens ?? 0}) out=${msg.usage.output_tokens}`);
    const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    switch (msg.stop_reason) {
      case "end_turn":
      case "stop_sequence": {
        push({ role: "assistant", content: msg.content });
        const why = TEXT_CALL.test(text) ? "text-call" : callsMade === 0 ? "no-action" : "";
        if (why && nudgesLeft > 0) {
          nudgesLeft--;
          log(`nudge: ${why}`);
          push({ role: "user", content: why === "text-call"
            ? "Your last message contains a tool call written as text, so it was not run. To run a tool, make a tool call, not text."
            : "Nothing has been done yet. Do the task yourself with the tools; don't describe steps for someone else to carry out." });
          continue;
        }
        if (!why && o.stopCheck && checksLeft > 0) {
          const back = await o.stopCheck(o.root);
          if (back) {
            checksLeft--;
            log("stop check: sent back");
            push({ role: "user", content: back });
            continue;
          }
        }
        return { status: why ? `done-${why}` as Status : "done", turns, text, outputTokens };
      }

      case "pause_turn": // a server tool hit its iteration limit; resend as is
        push({ role: "assistant", content: msg.content });
        continue;

      case "refusal": // never run tools from a refused turn; do not keep it
        log(`refusal: ${msg.stop_details?.category ?? "no category"}`);
        return { status: "refusal", turns, text, outputTokens };

      case "model_context_window_exceeded":
        await compact(messages, o, request, log);
        continue;

      case "max_tokens":
        // A tool_use cut off here usually still parses as a smaller object.
        // Running it would act on input the model never finished writing.
        if (!escalated && maxTokens < 128_000) {
          escalated = true;
          maxTokens = Math.min(128_000, maxTokens * 2);
          log(`max_tokens hit; retrying the turn with max_tokens=${maxTokens}`);
          continue; // the truncated response is discarded, not appended
        }
        push({ role: "assistant", content: msg.content.filter((b) => b.type !== "tool_use") });
        return { status: "max_tokens", turns, text, outputTokens };

      case "tool_use": {
        push({ role: "assistant", content: msg.content });
        callsMade += calls.length;
        const results = await runTools(calls, byName, ctx, o, log, recent);
        push({ role: "user", content: results });
        if (signal.aborted) return { status: "cancelled", turns, text, outputTokens };
        if (o.compactAtInputTokens && inputTotal > o.compactAtInputTokens) {
          await compact(messages, o, request, log);
        }
        continue;
      }

      default:
        throw new Error(`unhandled stop_reason: ${msg.stop_reason}`);
    }
  }
}

// Run one assistant turn's tool calls. Consecutive parallel-safe calls run
// together; anything with side effects runs alone, in the order the model
// wrote it. Results always come back in call order, in one user message.
async function runTools(
  calls: Anthropic.ToolUseBlock[], byName: Map<string, ToolSpec>, ctx: ToolContext,
  o: AgentOptions, log: (s: string) => void, recent: string[] = [],
): Promise<Anthropic.ToolResultBlockParam[]> {
  const results: Anthropic.ToolResultBlockParam[] = new Array(calls.length);
  let i = 0;
  while (i < calls.length) {
    const spec = byName.get(calls[i].name);
    let j = i + 1;
    if (spec?.parallelSafe) while (j < calls.length && byName.get(calls[j].name)?.parallelSafe) j++;
    const batch = calls.slice(i, j).map((c, k) => {
      const key = c.name + JSON.stringify(c.input);
      recent.push(key);
      if (recent.length > 3) recent.shift();
      if (o.repeatGuard && recent.length === 3 && recent.every((r) => r === key)) {
        results[i + k] = { type: "tool_result", tool_use_id: c.id, is_error: true,
          content: "Not run: this is the third identical call in a row, and it will give the same result. Change the approach: look at the error, read the relevant file, or try a different command." };
        return Promise.resolve();
      }
      return runOne(c, byName, ctx, o, log).then((r) => { results[i + k] = r; });
    });
    await Promise.all(batch);
    i = j;
  }
  return results;
}

async function runOne(
  call: Anthropic.ToolUseBlock, byName: Map<string, ToolSpec>, ctx: ToolContext,
  o: AgentOptions, log: (s: string) => void,
): Promise<Anthropic.ToolResultBlockParam> {
  const fail = (content: string): Anthropic.ToolResultBlockParam => ({ type: "tool_result", tool_use_id: call.id, is_error: true, content });
  const t0 = Date.now();
  if (ctx.signal.aborted) return fail("Cancelled by the user before it ran.");
  if (call.name === "__unparsed__") {
    const u = call.input as { raw?: string; error?: string };
    log(`  unparsed tool call: ${u.error}`);
    return fail(`Your tool call could not be parsed (${u.error}): ${String(u.raw).slice(0, 300)}\nWrite exactly one JSON object with "name" and "arguments", with strings properly escaped.`);
  }
  const spec = byName.get(call.name);
  if (!spec) return fail(`Unknown tool ${call.name}. Available: ${[...byName.keys()].join(", ")}.`);

  const parsed = spec.schema.safeParse(call.input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((x) => `${x.path.join(".") || "(input)"}: ${x.message}`).join("; ");
    log(`  ${call.name} rejected: invalid input (${issues})`);
    return fail(`Invalid input for ${call.name}: ${issues}`);
  }
  const summary = spec.summary(parsed.data);
  const verdict = o.policy.evaluate(call.name, summary);
  if (verdict.decision === "deny" || (verdict.decision === "ask" && !(await o.approve(call.name, summary, verdict.reason)))) {
    log(`  ${summary} -> refused (${verdict.reason})`);
    return fail(`Not run: the user's permission policy refused "${summary}" (${verdict.reason}). Do not retry it in another form; find another way or ask the user.`);
  }
  const blocked = await o.hooks?.preToolUse?.(call.name, parsed.data);
  if (blocked) return fail(blocked);

  let content: string, isError = false;
  try {
    content = await spec.run(parsed.data, ctx);
  } catch (e) {
    isError = true;
    if (e instanceof ToolError || e instanceof SandboxError) content = e.message;
    else content = `Internal error in ${call.name}: ${(e as Error).message}`; // a harness bug, still answered
  }
  content = (await o.hooks?.postToolUse?.(call.name, parsed.data, content, isError)) ?? content;
  const ms = Date.now() - t0;
  o.transcript.append({ t: "tool", name: call.name, ms, isError, summary });
  log(`  ${summary} -> ${isError ? "error" : "ok"} (${ms} ms)`);
  return { type: "tool_result", tool_use_id: call.id, content: clip(content), ...(isError ? { is_error: true } : {}) };
}

// Client-side compaction: ask the same model, over the same cached prefix, for
// a summary; then replace the whole history with it. Replacing all of it (not
// a middle slice) keeps the result append-only from here on, and it carries
// no thinking blocks whose prefix has changed.
async function compact(
  messages: Anthropic.MessageParam[], o: AgentOptions,
  request: (m: Anthropic.MessageParam[], extra?: Partial<Request>) => Request, log: (s: string) => void,
) {
  const first = messages[0];
  const last = messages.at(-1)!;
  const ask: Anthropic.TextBlockParam = { type: "text", text: SUMMARY_PROMPT };
  const forSummary = last.role === "user" && Array.isArray(last.content)
    ? [...messages.slice(0, -1), { ...last, content: [...last.content, ask] } as Anthropic.MessageParam]
    : [...messages, { role: "user" as const, content: [ask] }];
  const res = await o.model.send(request(forSummary, { tool_choice: { type: "none" } }));
  const summary = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const task = typeof first.content === "string" ? first.content
    : (first.content as Anthropic.ContentBlockParam[]).filter((b): b is Anthropic.TextBlockParam => b.type === "text").map((b) => b.text).join("\n");
  const dropped = messages.length;
  messages.length = 0;
  o.transcript.append({ t: "compaction", summaryChars: summary.length, droppedMessages: dropped });
  const m: Anthropic.MessageParam = {
    role: "user",
    content: `${task}\n\n<summary-of-earlier-work>\n${summary}\n</summary-of-earlier-work>\n\nContinue from the next step in the summary.`,
  };
  messages.push(m);
  o.transcript.append({ t: "message", message: m });
  log(`compacted: ${dropped} messages -> 1 (${summary.length} chars of summary)`);
}
