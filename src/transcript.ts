// Durable, append-only session log. One JSON object per line, fsynced, so a
// crash loses at most the line being written and the session can resume.
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";

export type Event =
  | { t: "message"; message: Anthropic.MessageParam }
  | { t: "usage"; turn: number; usage: Anthropic.Usage; stop: string | null }
  | { t: "compaction"; summaryChars: number; droppedMessages: number }
  | { t: "tool"; name: string; ms: number; isError: boolean; summary: string };

export class Transcript {
  private fd: number;
  constructor(public file: string) {
    this.fd = fs.openSync(file, "a");
  }
  append(e: Event) {
    fs.writeSync(this.fd, JSON.stringify(e) + "\n");
    fs.fsyncSync(this.fd);
  }
  close() { fs.closeSync(this.fd); }

  // Rebuild the message list. A compaction event marks where the history was
  // replaced, so only messages after the last one count.
  static load(file: string): Anthropic.MessageParam[] {
    if (!fs.existsSync(file)) return [];
    let msgs: Anthropic.MessageParam[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: Event;
      try { e = JSON.parse(line); } catch { break; } // torn last line from a crash
      if (e.t === "compaction") msgs = [];
      if (e.t === "message") msgs.push(e.message);
    }
    return repair(msgs);
  }
}

// The API requires every tool_use to be answered by a tool_result in the very
// next user message. A crash between the two leaves a dangling call. We cannot
// know whether the tool ran, so we say exactly that.
export function repair(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = msgs.at(-1);
  if (!last || last.role !== "assistant" || typeof last.content === "string") return msgs;
  const calls = last.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use");
  if (!calls.length) return msgs;
  return [...msgs, {
    role: "user",
    content: calls.map((c) => ({
      type: "tool_result" as const,
      tool_use_id: c.id,
      is_error: true,
      content: "The harness restarted before this call returned. It may or may not have taken effect; check the current state before repeating it.",
    })),
  }];
}
