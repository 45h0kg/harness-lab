// The only place the harness talks to the network. Everything else depends on
// the Model interface, so tests can swap in a scripted model.
import Anthropic from "@anthropic-ai/sdk";

export type Request = Omit<Anthropic.MessageCreateParamsNonStreaming, "stream">;

export interface Model {
  send(req: Request, signal?: AbortSignal): Promise<Anthropic.Message>;
}

export class ClaudeModel implements Model {
  // maxRetries covers 408/409/429/5xx and connection errors with exponential
  // backoff that honours retry-after. The timeout is per attempt.
  constructor(
    private client = new Anthropic({ maxRetries: 4, timeout: 10 * 60 * 1000 }),
    private onText: (delta: string) => void = (d) => process.stdout.write(d),
  ) {}

  async send(req: Request, signal?: AbortSignal): Promise<Anthropic.Message> {
    // Streaming keeps long generations under HTTP idle timeouts and lets the
    // user watch text arrive. finalMessage() assembles the complete Message.
    const stream = this.client.messages.stream(req, { signal });
    stream.on("text", this.onText);
    return stream.finalMessage();
  }
}
