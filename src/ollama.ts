// A Model backed by a local Ollama server. The harness keeps one message format
// (the Anthropic Messages shape); this adapter translates it to Ollama's
// /api/chat and translates the reply back, so the same loop runs on both.
import Anthropic from "@anthropic-ai/sdk";
import type { Model, Request } from "./model.js";

interface OllamaToolCall { id?: string; function: { name: string; arguments: Record<string, unknown> | string } }
interface OllamaMessage { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: OllamaToolCall[]; tool_name?: string; tool_call_id?: string }

export interface OllamaTimings {
  prompt_eval_count: number; prompt_eval_cached_count: number; eval_count: number;
  prompt_eval_ms: number; eval_ms: number; total_ms: number; load_ms: number; done_reason: string;
}

const text = (c: string | readonly { type: string }[]) =>
  typeof c === "string" ? c : (c.filter((b) => b.type === "text") as Anthropic.TextBlockParam[]).map((b) => b.text).join("\n");

export function toOllama(req: Request): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (req.system) out.push({ role: "system", content: typeof req.system === "string" ? req.system : text(req.system) });
  for (const m of req.messages) {
    if (m.role === "system") { out.push({ role: "system", content: text(m.content) }); continue; }
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const calls = m.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use");
      out.push({
        role: "assistant", content: text(m.content),
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.input as Record<string, unknown> } })) } : {}),
      });
      continue;
    }
    const names = new Map<string, string>();
    for (const prev of req.messages) if (prev.role === "assistant" && Array.isArray(prev.content))
      for (const b of prev.content) if (b.type === "tool_use") names.set(b.id, b.name);
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const body = typeof b.content === "string" ? b.content : text((b.content ?? []) as Anthropic.TextBlockParam[]);
        out.push({ role: "tool", tool_call_id: b.tool_use_id, tool_name: names.get(b.tool_use_id), content: b.is_error ? `ERROR: ${body}` : body });
      }
    }
    const rest = text(m.content);
    if (rest) out.push({ role: "user", content: rest });
  }
  return out;
}

export class OllamaModel implements Model {
  last?: OllamaTimings;
  constructor(public name: string, private opts: { num_ctx: number; host?: string; options?: Record<string, unknown> }) {}

  async send(req: Request, signal?: AbortSignal): Promise<Anthropic.Message> {
    const body = {
      model: this.name,
      stream: false,
      messages: toOllama(req),
      tools: (req.tools ?? []).map((t) => {
        const tool = t as Anthropic.Tool;
        return { type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.input_schema } };
      }),
      options: { num_ctx: this.opts.num_ctx, num_predict: req.max_tokens, ...this.opts.options },
      keep_alive: "30m",
    };
    const res = await fetch(`${this.opts.host ?? "http://localhost:11434"}/api/chat`, {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal,
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    const r = await res.json() as {
      message: OllamaMessage; done_reason: string; prompt_eval_count?: number; prompt_eval_cached_count?: number;
      eval_count?: number; prompt_eval_duration?: number; eval_duration?: number; total_duration?: number; load_duration?: number;
    };
    this.last = {
      prompt_eval_count: r.prompt_eval_count ?? 0, prompt_eval_cached_count: r.prompt_eval_cached_count ?? 0,
      eval_count: r.eval_count ?? 0, prompt_eval_ms: (r.prompt_eval_duration ?? 0) / 1e6, eval_ms: (r.eval_duration ?? 0) / 1e6,
      total_ms: (r.total_duration ?? 0) / 1e6, load_ms: (r.load_duration ?? 0) / 1e6, done_reason: r.done_reason,
    };
    const content: Anthropic.ContentBlock[] = [];
    if (r.message.content) content.push({ type: "text", text: r.message.content, citations: null });
    for (const [i, c] of (r.message.tool_calls ?? []).entries()) {
      let input: unknown = c.function.arguments;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* leave as string; validation reports it */ } }
      content.push({ type: "tool_use", id: c.id ?? `call_${Date.now()}_${i}`, name: c.function.name, input, caller: { type: "direct" } });
    }
    const stop: Anthropic.StopReason = r.done_reason === "length" ? "max_tokens"
      : (r.message.tool_calls?.length ? "tool_use" : "end_turn");
    return {
      id: `ollama_${Date.now()}`, type: "message", role: "assistant", model: this.name, container: null, diagnostics: null,
      content, stop_reason: stop, stop_sequence: null, stop_details: null,
      usage: {
        input_tokens: (r.prompt_eval_count ?? 0) - (r.prompt_eval_cached_count ?? 0), output_tokens: r.eval_count ?? 0,
        cache_read_input_tokens: r.prompt_eval_cached_count ?? 0, cache_creation_input_tokens: 0, cache_creation: null,
        inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: "standard", speed: "standard",
      },
    };
  }
}
