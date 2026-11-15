// What every agent variant returns, so the bench can compare them.
import Anthropic from "@anthropic-ai/sdk";
import type { Model } from "./model.js";

export interface AgentRun {
  status: string;          // done, max_turns, error, ...
  text: string;            // the final assistant text
  turns: number;
  toolCalls: number;
  toolErrors: number;
  messages: Anthropic.MessageParam[];
  error?: string;
}

// signal: aborted when the run is out of time; the agent should stop its loop and any command it is running.
export type Agent = (task: string, dir: string, model: Model, signal?: AbortSignal) => Promise<AgentRun>;
