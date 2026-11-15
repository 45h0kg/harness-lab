// Chapter 17: a Claude adapter with a spending limit, for running the bench on your own API key.
// Type-checked against this lab; not run by the author.
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeModel, type Model, type Request } from "./model.js";

// Sets the model id on every request and keeps each response's usage.
export class MeteredClaude implements Model {
  usage: Anthropic.Usage[] = [];
  private inner = new ClaudeModel(undefined, () => {});
  constructor(private id: string, private limitUSD: number) {}
  async send(req: Request, signal?: AbortSignal) {
    if (this.dollars() >= this.limitUSD) throw new Error(`spending limit of $${this.limitUSD} reached`);
    const m = await this.inner.send({ ...req, model: this.id }, signal);
    this.usage.push(m.usage);
    return m;
  }
  dollars() { return this.usage.reduce((s, u) => s + cost(this.id, u), 0); }
}

// US dollars per million tokens, from Anthropic's model list in November 2026. Check current prices.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5":   { input: 4,    output: 20,   cacheRead: 0.20, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2,    output: 10,   cacheRead: 0.10, cacheWrite: 2.5 },
  "claude-haiku-5-5":  { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function cost(model: string, u: Anthropic.Usage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no prices for ${model}`);
  return (u.input_tokens * p.input + u.output_tokens * p.output
    + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6;
}
