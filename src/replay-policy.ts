// Chapter 12: replay every tool call from earlier experiments through a permission
// policy, and count what a user would have been asked to approve.
// tsx src/replay-policy.ts runs/ch05-loop runs/ch06-tools ...
import fs from "node:fs";
import path from "node:path";
import { Policy, type Rule } from "./permissions.js";

const RULES: Rule[] = [
  { tool: "bash", match: /\brm\s+-\w*r\w*f|\brm\s+-\w*f\w*r/, decision: "deny", reason: "recursive forced delete" },
  { tool: "bash", match: /\bgit\s+push\b/, decision: "deny", reason: "pushing is the user's call" },
  { tool: "bash", match: /\b(killall|pkill|sudo)\b/, decision: "deny", reason: "affects the whole machine" },
  { tool: "bash", match: /^bash: (npm test|node --test|git (status|diff|log)|ls|cat|grep|head|tail|wc|pwd)\b/, decision: "allow" },
  { tool: "edit_file", decision: "allow" },
  { tool: "write_file", decision: "allow" },
];
const KNOWN = new Set(["bash", "read_file", "list_files", "edit_file", "write_file"]);
const policy = new Policy(RULES, new Set(["read_file", "list_files"]));
const summary = (name: string, input: any) =>
  name === "bash" ? `bash: ${input.command}` : `${name}: ${input.path ?? ""}`;

for (const exp of process.argv.slice(2)) {
  for (const g of fs.readdirSync(exp).sort()) {
    const gd = path.join(exp, g);
    if (!fs.statSync(gd).isDirectory()) continue;
    let runs = 0, calls = 0, asks = 0, denies = 0, runsAsked = 0;
    const perRun: number[] = [];
    const askReasons: Record<string, number> = {}, askCmds: Record<string, number> = {}, denied: string[] = [];
    for (const r of fs.readdirSync(gd)) {
      const f = path.join(gd, r, "transcript.json");
      if (!fs.existsSync(f)) continue;
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      runs++;
      let a = 0;
      for (const m of d.messages ?? []) if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) {
        if (b.type !== "tool_use" || b.input?.raw !== undefined) continue;   // unparsed calls never reach the policy
        // nor do unknown tools or input that fails the schema (approximated: the field each tool needs)
        if (!KNOWN.has(b.name) || typeof (b.name === "bash" ? b.input?.command : b.name === "list_files" ? (b.input?.path ?? "") : b.input?.path) !== "string") continue;
        calls++;
        const s = summary(b.name, b.input);
        const v = policy.evaluate(b.name, s);
        if (v.decision === "ask") { a++; askReasons[v.reason] = (askReasons[v.reason] ?? 0) + 1; const k = s.replace(/^bash: /, "").split(/\s+/)[0]; askCmds[k] = (askCmds[k] ?? 0) + 1; }
        if (v.decision === "deny") { denies++; denied.push(`${r}: ${s.slice(0, 80)}`); }
      }
      asks += a; perRun.push(a); if (a) runsAsked++;
    }
    if (!runs) continue;
    perRun.sort((x, y) => x - y);
    const top = Object.entries(askCmds).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => `${k}:${n}`).join(" ");
    console.log(`${exp.split("/").pop()}/${g}  runs ${runs}  calls ${calls}  asks ${asks} (in ${runsAsked} runs, median ${perRun[perRun.length >> 1]}/run, max ${perRun.at(-1)})  denies ${denies}`);
    console.log(`    ask reasons ${JSON.stringify(askReasons)}  first words ${top}`);
    for (const x of denied) console.log(`    DENY ${x}`);
  }
}
