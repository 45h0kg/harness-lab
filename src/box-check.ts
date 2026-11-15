// Chapter 11: what each boundary does with the same four calls, no model involved.
// tsx src/box-check.ts
import fs from "node:fs";
import path from "node:path";
import { buildTools, FULL } from "./toolkit.js";
import { EXTRA_TASKS, prepare } from "./tasks.js";

const base = path.resolve(import.meta.dirname, "../runs/zz-box-check");
const kits = {
  "box-off": { ...FULL, shell: "safe" as const, confine: false },
  "box-files": { ...FULL, shell: "safe" as const, confine: true },
  "box-os": { ...FULL, shell: "sandboxed" as const, confine: true },
};
const calls = [
  ["shared-rate", "read_file", { path: "shared/settings.json" }],
  ["shared-rate", "bash", { command: "cat shared/settings.json" }],
  ["release-notes", "write_file", { path: "../release-notes.md", content: "# Release notes\n\n- EUR\n" }],
  ["release-notes", "bash", { command: "echo '- Default currency is now EUR.' >> ../release-notes.md" }],
] as const;
for (const [name, kit] of Object.entries(kits)) {
  const tools = buildTools(kit);
  for (const [taskId, tool, input] of calls) {
    const task = EXTRA_TASKS.find((t) => t.id === taskId)!;
    const runDir = path.join(base, name, taskId);
    fs.mkdirSync(runDir, { recursive: true });
    const dir = prepare(task, runDir);
    const spec = tools.find((t) => t.def.name === tool)!;
    let out: string;
    try { out = "ok: " + String(await spec.run(input as never, { root: dir, signal: new AbortController().signal, seen: new Map() })); }
    catch (e) { out = "refused: " + (e as Error).message; }
    console.log(`${name.padEnd(10)} ${tool.padEnd(10)} ${JSON.stringify(input).slice(0, 60).padEnd(60)} ${out.replace(/\s+/g, " ").slice(0, 110)}  [check: ${task.check(dir, "").why}]`);
  }
}
