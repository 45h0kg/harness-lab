// Named agent configurations, one per chapter step.
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "./agent.js";
import type { Hooks } from "./loop.js";
import { workspaceCheck } from "./stopcheck.js";
import { bareAgent, SYSTEM as SYSTEM_BARE } from "./bare.js";
import { makeAgent, SYSTEM_FULL, SYSTEM_MIN } from "./harness.js";
import { FULL, type Kit } from "./toolkit.js";

const BASH_ONLY: Kit = { ...FULL, set: "bash", describe: "terse", errors: "raw", clip: "none", shell: "naive", staleness: false, confine: false };

const LOOP = { nudges: 2, repeatGuard: true };
const TOOLS: Kit = { ...BASH_ONLY, set: "files", describe: "full", edit: "replace" };
const ERRORS: Kit = { ...TOOLS, errors: "instructive" };
const CLIP: Kit = { ...ERRORS, clip: "headtail", clipChars: 12_000 };
const STALE: Kit = { ...CLIP, staleness: true };

// ch09: someone else changes src/cart.js right after the agent first reads it,
// the way a teammate, a formatter or another agent would.
export const TEAMMATE_LINE = "// Owned by the payments team: talk to them before changing totals.";
const teammate = (dir: string): Hooks => {
  let done = false;
  return {
    async postToolUse(name, input) {
      const p = (input as { path?: string }).path ?? "";
      if (done || name !== "read_file" || path.normalize(p) !== "src/cart.js") return;
      done = true;
      fs.appendFileSync(path.join(dir, "src/cart.js"), `\n${TEAMMATE_LINE}\n`);
    },
  };
};

export const VARIANTS: Record<string, Agent> = {
  bare: bareAgent,
  // ch04 baseline: the configurable loop and the bash-only kit, with bare's one-line system prompt
  base: makeAgent({ kit: BASH_ONLY, system: SYSTEM_BARE }),
  // ch04: same bare tool and loop, but a system prompt that says where it is and when it's done
  prompt: makeAgent({ kit: BASH_ONLY, system: SYSTEM_FULL }),
  // ch05: plus a loop that pushes back on endings that did nothing, and refuses repeats
  loop: makeAgent({ kit: BASH_ONLY, system: SYSTEM_FULL, loop: LOOP }),
  // ch05: plus a stop check that reports an unchanged tree or failing tests before it may finish
  verify: makeAgent({ kit: BASH_ONLY, system: SYSTEM_FULL, loop: { ...LOOP, stopCheck: workspaceCheck } }),
  // ch06: file tools (read, list, exact-string edit, write) with descriptions that say when to use them
  tools: makeAgent({ kit: TOOLS, system: SYSTEM_FULL, loop: LOOP }),
  // ch06: the same tools, with a replace_all switch on edit_file for renames
  "tools-all": makeAgent({ kit: { ...TOOLS, replaceAll: true }, system: SYSTEM_FULL, loop: LOOP }),
  // ch07: plus error messages that say what to do next
  errors: makeAgent({ kit: ERRORS, system: SYSTEM_FULL, loop: LOOP }),
  // ch08: long output cut to its first 12,000 characters, or to its first and last 6,000
  "clip-head": makeAgent({ kit: { ...ERRORS, clip: "head", clipChars: 12_000 }, system: SYSTEM_FULL, loop: LOOP }),
  clip: makeAgent({ kit: CLIP, system: SYSTEM_FULL, loop: LOOP }),
  // ch09: a concurrent change to a file the agent has read, without and with the staleness check
  "stale-off": makeAgent({ kit: CLIP, system: SYSTEM_FULL, loop: LOOP, hooks: teammate }),
  "stale-on": makeAgent({ kit: STALE, system: SYSTEM_FULL, loop: LOOP, hooks: teammate }),
  // ch10: commands run with the naive runner, or with the safe one (closed stdin, own process
  // group, the whole group stopped on timeout, background leftovers stopped when the shell exits)
  "shell-naive": makeAgent({ kit: STALE, system: SYSTEM_FULL, loop: LOOP }),
  "shell-safe": makeAgent({ kit: { ...STALE, shell: "safe" }, system: SYSTEM_FULL, loop: LOOP }),
  // ch10: the safe runner, with a description that says how background processes behave
  "shell-safe-hint": makeAgent({ kit: { ...STALE, shell: "safe", backgroundHint: true }, system: SYSTEM_FULL, loop: LOOP }),
  // ch12: no policy (everything runs), and a policy that denies rm, refuses compound shell
  // commands it can't follow, and allows the rest. Nobody is there to answer "ask", so it means no.
  "perm-open": makeAgent({ kit: { ...STALE, shell: "safe" }, system: SYSTEM_FULL, loop: LOOP }),
  "perm-rules": makeAgent({ kit: { ...STALE, shell: "safe" }, system: SYSTEM_FULL, loop: LOOP, rules: [
    { tool: "bash", match: /\brm\b/, decision: "deny", reason: "deleting files needs the user's approval" },
    { tool: "*", decision: "allow" },
  ] }),
  // ch11: no boundary; file tools confined to the workspace; and the shell confined by the OS too
  "box-off": makeAgent({ kit: { ...STALE, shell: "safe", confine: false }, system: SYSTEM_FULL, loop: LOOP }),
  "box-files": makeAgent({ kit: { ...STALE, shell: "safe", confine: true }, system: SYSTEM_FULL, loop: LOOP }),
  "box-os": makeAgent({ kit: { ...STALE, shell: "sandboxed", confine: true }, system: SYSTEM_FULL, loop: LOOP }),
};
export { SYSTEM_MIN };
