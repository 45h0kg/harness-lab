import { spawnSync } from "node:child_process";
import { buildTools, FULL } from "./toolkit.js";
const cmds = ["sleep 20 & echo started", "node -e 'setInterval(()=>{},1000)'", "read x; echo got $x"];
for (const c of cmds) {
  let t = Date.now();
  const r = spawnSync("/bin/sh", ["-c", c], { encoding: "utf8", timeout: 3000 });
  console.log(`naive  ${(Date.now() - t) / 1000}s status=${r.status} signal=${r.signal} out=${JSON.stringify((r.stdout ?? "").trim())} :: ${c}`);
  const bash = buildTools({ ...FULL }).find((x) => x.def.name === "bash")!;
  t = Date.now();
  try { const out = await bash.run({ command: c, timeout_ms: 3000 }, { root: process.cwd(), signal: new AbortController().signal, seen: new Map() }); console.log(`safe   ${(Date.now() - t) / 1000}s ${JSON.stringify(out.slice(0, 80))}`); }
  catch (e) { console.log(`safe   ${(Date.now() - t) / 1000}s error ${JSON.stringify(String((e as Error).message).slice(0, 80))}`); }
}
process.exit(0);
