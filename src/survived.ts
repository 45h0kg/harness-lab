// Chapter 9: for each run, did the agent read src/cart.js (so the teammate's
// line was added), and is that line still in the file at the end?
// tsx src/survived.ts runs/ch09-stale
import fs from "node:fs";
import path from "node:path";
import { TEAMMATE_LINE } from "./variants.js";

const exp = path.resolve(process.argv[2]);
for (const g of fs.readdirSync(exp).sort()) {
  const gd = path.join(exp, g);
  if (!fs.statSync(gd).isDirectory()) continue;
  let read = 0, kept = 0, lost = 0, pass = 0, refusals = 0;
  for (const r of fs.readdirSync(gd)) {
    const f = path.join(gd, r, "transcript.json");
    if (!fs.existsSync(f)) continue;
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    if (d.rec.pass) pass++;
    const readCart = d.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_use" && b.name === "read_file" && path.normalize(b.input.path ?? "") === "src/cart.js"));
    for (const m of d.messages) if (Array.isArray(m.content)) for (const b of m.content)
      if (b.type === "tool_result" && typeof b.content === "string" && /changed since you last read it|have not read its current content/.test(b.content)) refusals++;
    if (!readCart) continue;
    read++;
    const now = fs.readFileSync(path.join(gd, r, "work/src/cart.js"), "utf8");
    if (now.includes(TEAMMATE_LINE)) kept++; else lost++;
  }
  console.log(`${g.padEnd(28)} passed ${pass}  read cart.js ${read}  teammate line kept ${kept}  lost ${lost}  stale refusals ${refusals}`);
}
