// Summarize an experiment from its transcripts: pass rates per variant and model,
// pass@3 and pass^3 per task, and cost figures computed from per-call timings.
// tsx src/report.ts runs/<exp> [--by-task]
import fs from "node:fs";
import path from "node:path";

const exp = path.resolve(process.argv[2]);
const byTask = process.argv.includes("--by-task");
interface Call { prompt_eval_count: number; prompt_eval_cached_count: number; eval_count: number; prompt_eval_ms: number; eval_ms: number }
interface Rec { agent: string; model: string; task: string; run: number; pass: boolean; status: string; turns: number; toolCalls: number; toolErrors: number; ms: number }
const rows: (Rec & { group: string; calls: Call[] })[] = [];
for (const group of fs.readdirSync(exp)) {
  const g = path.join(exp, group);
  if (!fs.statSync(g).isDirectory()) continue;
  for (const run of fs.readdirSync(g)) {
    const f = path.join(g, run, "transcript.json");
    if (!fs.existsSync(f)) continue;
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    rows.push({ ...d.rec, group, calls: d.calls });
  }
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const keys = [...new Set(rows.map((r) => r.group))].sort();
console.log("variant          model         pass     pass@3  pass^3  med.turns  med.s  prompt tok/run  cached%  out tok/run  statuses");
for (const k of keys) {
  const rs = rows.filter((r) => r.group === k);
  const tasks = [...new Set(rs.map((r) => r.task))];
  const at = tasks.filter((t) => rs.some((r) => r.task === t && r.pass)).length;
  const all = tasks.filter((t) => rs.filter((r) => r.task === t).every((r) => r.pass)).length;
  const prompt = rs.map((r) => r.calls.reduce((s, c) => s + c.prompt_eval_count, 0));
  const cached = rs.reduce((s, r) => s + r.calls.reduce((a, c) => a + c.prompt_eval_cached_count, 0), 0);
  const totalPrompt = prompt.reduce((a, b) => a + b, 0);
  const out = rs.map((r) => r.calls.reduce((s, c) => s + c.eval_count, 0));
  const st: Record<string, number> = {};
  for (const r of rs) st[r.status] = (st[r.status] ?? 0) + 1;
  const agent = k.replace(/-(qwen|llama).*/, ""), model = rs[0].model;
  console.log(`${agent.padEnd(16)} ${model.padEnd(13)} ${String(rs.filter((r) => r.pass).length).padStart(2)}/${String(rs.length).padEnd(4)}  ${at}/${tasks.length}     ${all}/${tasks.length}     ${String(median(rs.map((r) => r.turns))).padStart(5)}    ${(median(rs.map((r) => r.ms)) / 1000).toFixed(0).padStart(5)}  ${String(Math.round(totalPrompt / rs.length)).padStart(9)}       ${String(Math.round(100 * cached / Math.max(1, totalPrompt))).padStart(3)}%   ${String(Math.round(out.reduce((a, b) => a + b, 0) / rs.length)).padStart(7)}     ${Object.entries(st).map(([s, n]) => `${s}:${n}`).join(" ")}`);
  if (byTask) for (const t of tasks) {
    const tr = rs.filter((r) => r.task === t).sort((a, b) => a.run - b.run);
    console.log(`    ${t.padEnd(14)} ${tr.map((r) => (r.pass ? "P" : ".")).join("")}`);
  }
}
