// A Model that owns the whole wire: it renders the model's chat template
// itself, sends the text to Ollama's raw /api/generate endpoint, and parses
// tool calls out of the generated text itself. Nothing the model writes is
// dropped: a call that doesn't parse comes back as a tool_use named
// "__unparsed__" so the loop can tell the model what was wrong.
import Anthropic from "@anthropic-ai/sdk";
import type { Model, Request } from "./model.js";
import type { OllamaTimings } from "./ollama.js";

export interface Rendered { prompt: string; stop: string[] }
type Msg = Anthropic.MessageParam;
type Tool = Anthropic.Tool;

const textOf = (c: Msg["content"]) =>
  typeof c === "string" ? c : (c as { type: string }[]).filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlockParam).text).join("\n");

// Go's encoding/json, as Ollama uses it: map keys sorted, no spaces, and only
// the schema fields Ollama's ToolFunction struct keeps (type, items, description, enum).
function goJSON(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(goJSON).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${goJSON((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function fnJSON(t: Tool): string {
  const s = t.input_schema as { required?: string[]; properties?: Record<string, any> };
  const props: Record<string, string> = {};
  for (const k of Object.keys(s.properties ?? {}).sort()) {
    const p = s.properties![k];
    const parts = [`"type":${JSON.stringify(p.type ?? "string")}`];
    if (p.items) parts.push(`"items":${goJSON(p.items)}`);
    if (p.description) parts.push(`"description":${JSON.stringify(p.description)}`);
    if (p.enum) parts.push(`"enum":${JSON.stringify(p.enum)}`);
    props[k] = `{${parts.join(",")}}`;
  }
  const params = `{"type":"object"${s.required?.length ? `,"required":${JSON.stringify(s.required)}` : ""},"properties":{${Object.entries(props).map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(",")}}}`;
  return `{"name":${JSON.stringify(t.name)},"description":${JSON.stringify(t.description ?? "")},"parameters":${params}}`;
}

// Flatten the Messages-shaped history into role/content/calls the templates use.
interface Flat { role: "user" | "assistant" | "tool"; content: string; calls?: { name: string; args: unknown; raw?: string }[] }
function flatten(req: Request): Flat[] {
  const out: Flat[] = [];
  for (const m of req.messages) {
    if (m.role === "system") { out.push({ role: "user", content: textOf(m.content) }); continue; }
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const calls = m.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use");
      // A call that didn't parse goes back exactly as the model wrote it.
      out.push({ role: "assistant", content: textOf(m.content), calls: calls.map((c) => c.name === "__unparsed__" ? { name: "", args: undefined, raw: String((c.input as any).raw) } : { name: c.name, args: c.input }) });
      continue;
    }
    for (const b of m.content) if (b.type === "tool_result") {
      const body = typeof b.content === "string" ? b.content : textOf((b.content ?? []) as Anthropic.TextBlockParam[]);
      out.push({ role: "tool", content: b.is_error ? `ERROR: ${body}` : body });
    }
    const rest = textOf(m.content);
    if (rest) out.push({ role: "user", content: rest });
  }
  return out;
}
const sysOf = (req: Request) => (typeof req.system === "string" ? req.system : (req.system ?? []).map((b) => b.text).join("\n"));
const argsJSON = (a: unknown) => (typeof a === "string" ? a : goJSON(a));

export function renderQwen(req: Request): Rendered {
  const sys = sysOf(req), tools = (req.tools ?? []) as Tool[], msgs = flatten(req);
  let p = "";
  if (sys || tools.length) {
    p += "<|im_start|>system";
    if (sys) p += "\n" + sys;
    if (tools.length) {
      p += "\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>";
      for (const t of tools) p += `\n{"type": "function", "function": ${fnJSON(t)}}`;
      p += "\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{\"name\": <function-name>, \"arguments\": <args-json-object>}\n</tool_call>";
    }
    p += "<|im_end|>\n";
  }
  msgs.forEach((m, i) => {
    const last = i === msgs.length - 1;
    if (m.role === "user") p += `<|im_start|>user\n${m.content}<|im_end|>\n`;
    else if (m.role === "assistant") {
      // Ollama's template keeps only the text when a message has text and calls;
      // the harness renders both, the way the model wrote them.
      p += "<|im_start|>assistant\n";
      if (m.content) p += m.content;
      if (m.calls?.length) p += `${m.content ? "\n" : ""}<tool_call>\n${m.calls.map((c) => (c.raw ?? `{"name": "${c.name}", "arguments": ${argsJSON(c.args)}}`) + "\n").join("")}</tool_call>`;
      if (!last) p += "<|im_end|>\n";
    } else p += `<|im_start|>user\n<tool_response>\n${m.content}\n</tool_response><|im_end|>\n`;
    if (m.role !== "assistant" && last) p += "<|im_start|>assistant\n";
  });
  return { prompt: p, stop: ["<|im_end|>", "<|endoftext|>"] };
}

export function renderLlama(req: Request): Rendered {
  const sys = sysOf(req), tools = (req.tools ?? []) as Tool[], msgs = flatten(req);
  let p = "";
  if (sys || tools.length) {
    p += "<|start_header_id|>system<|end_header_id|>";
    if (sys) p += "\n\n" + sys;
    if (tools.length) p += "\n\nCutting Knowledge Date: December 2023\n\nWhen you receive a tool call response, use the output to format an answer to the orginal user question.\n\nYou are a helpful assistant with tool calling capabilities.";
    p += "<|eot_id|>";
  }
  msgs.forEach((m, i) => {
    const last = i === msgs.length - 1;
    if (m.role === "user") {
      p += "<|start_header_id|>user<|end_header_id|>";
      // Ollama's template lists the tools only in the last user message. Once a
      // tool result is last, the definitions are gone from the prompt.
      if (tools.length && last) {
        p += "\n\nGiven the following functions, please respond with a JSON for a function call with its proper arguments that best answers the given prompt.\n\nRespond in the format {\"name\": function name, \"parameters\": dictionary of argument name and its value}. Do not use variables.\n\n";
        for (const t of tools) p += `{"type":"function","function":${fnJSON(t)}}\n`;
        p += `\nQuestion: ${m.content}<|eot_id|>`;
      } else p += `\n\n${m.content}<|eot_id|>`;
      if (last) p += "<|start_header_id|>assistant<|end_header_id|>\n\n";
    } else if (m.role === "assistant") {
      p += "<|start_header_id|>assistant<|end_header_id|>";
      if (m.calls?.length) p += m.calls.map((c) => "\n" + (c.raw ?? `{"name": "${c.name}", "parameters": ${argsJSON(c.args)}}`)).join("");
      else p += `\n\n${m.content}`;
      if (!last) p += "<|eot_id|>";
    } else {
      p += `<|start_header_id|>ipython<|end_header_id|>\n\n${m.content}<|eot_id|>`;
      if (last) p += "<|start_header_id|>assistant<|end_header_id|>\n\n";
    }
  });
  return { prompt: p, stop: ["<|eot_id|>", "<|eom_id|>", "<|start_header_id|>"] };
}

// Find JSON objects in text by brace matching, respecting strings.
function jsonObjects(s: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { out.push({ start: i, end: j + 1, text: s.slice(i, j + 1) }); i = j; break; }
    }
  }
  return out;
}

export interface Parsed { text: string; calls: { name: string; input: unknown; error?: string; raw?: string }[] }

export function parseQwen(out: string): Parsed {
  const calls: Parsed["calls"] = [];
  const re = /<tool_call>([\s\S]*?)(<\/tool_call>|$)/g;
  const text = out.replace(re, (_m, body: string) => {
    for (const line of body.trim().split(/\n(?=\s*\{)/)) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line.trim());
        if (typeof j.name !== "string") throw new Error('no "name"');
        calls.push({ name: j.name, input: typeof j.arguments === "string" ? safeParse(j.arguments) : j.arguments ?? {} });
      } catch (e) { calls.push({ name: "__unparsed__", input: {}, error: (e as Error).message, raw: line.trim() }); }
    }
    return "";
  }).trim();
  return { text, calls };
}

export function parseLlama(out: string): Parsed {
  const calls: Parsed["calls"] = [];
  let text = out;
  for (const o of jsonObjects(out).reverse()) {
    let j: any;
    try { j = JSON.parse(o.text); } catch { continue; }
    if (typeof j?.name === "string" && (j.parameters !== undefined || j.arguments !== undefined)) {
      calls.unshift({ name: j.name, input: j.parameters ?? j.arguments });
      text = text.slice(0, o.start) + text.slice(o.end);
    }
  }
  if (!calls.length && /^\s*\{\s*"name"/.test(out)) calls.push({ name: "__unparsed__", input: {}, error: "not valid JSON", raw: out.trim() });
  return { text: calls.length ? text.trim() : out, calls };
}

function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }

export class RawOllamaModel implements Model {
  last?: OllamaTimings & { raw: string; prompt_chars: number };
  private render: (r: Request) => Rendered;
  private parse: (s: string) => Parsed;
  constructor(public name: string, private opts: { num_ctx: number; host?: string }) {
    if (name.startsWith("qwen2.5")) { this.render = renderQwen; this.parse = parseQwen; }
    else if (name.startsWith("llama3.1")) { this.render = renderLlama; this.parse = parseLlama; }
    else throw new Error(`no template for ${name}`);
  }
  async send(req: Request, signal?: AbortSignal): Promise<Anthropic.Message> {
    const { prompt, stop } = this.render(req);
    const res = await fetch(`${this.opts.host ?? "http://localhost:11434"}/api/generate`, {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.name, raw: true, stream: false, prompt, keep_alive: "30m",
        options: { num_ctx: this.opts.num_ctx, num_predict: req.max_tokens, stop } }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    const r = await res.json() as { response: string; done_reason: string; prompt_eval_count?: number; prompt_eval_cached_count?: number; eval_count?: number; prompt_eval_duration?: number; eval_duration?: number; total_duration?: number; load_duration?: number };
    this.last = {
      prompt_eval_count: r.prompt_eval_count ?? 0, prompt_eval_cached_count: r.prompt_eval_cached_count ?? 0, eval_count: r.eval_count ?? 0,
      prompt_eval_ms: (r.prompt_eval_duration ?? 0) / 1e6, eval_ms: (r.eval_duration ?? 0) / 1e6, total_ms: (r.total_duration ?? 0) / 1e6,
      load_ms: (r.load_duration ?? 0) / 1e6, done_reason: r.done_reason, raw: r.response, prompt_chars: prompt.length,
    };
    const parsed = this.parse(r.response);
    const content: Anthropic.ContentBlock[] = [];
    if (parsed.text) content.push({ type: "text", text: parsed.text, citations: null });
    parsed.calls.forEach((c, i) => content.push({
      type: "tool_use", id: `call_${Date.now().toString(36)}_${i}`, caller: { type: "direct" },
      name: c.name, input: c.name === "__unparsed__" ? { raw: c.raw, error: c.error } : c.input,
    }));
    const stop_reason: Anthropic.StopReason = r.done_reason === "length" ? "max_tokens" : parsed.calls.length ? "tool_use" : "end_turn";
    return {
      id: `raw_${Date.now()}`, type: "message", role: "assistant", model: this.name, container: null, diagnostics: null,
      content, stop_reason, stop_sequence: null, stop_details: null,
      usage: { input_tokens: (r.prompt_eval_count ?? 0) - (r.prompt_eval_cached_count ?? 0), output_tokens: r.eval_count ?? 0,
        cache_read_input_tokens: r.prompt_eval_cached_count ?? 0, cache_creation_input_tokens: 0, cache_creation: null,
        inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: "standard", speed: "standard" },
    };
  }
}
