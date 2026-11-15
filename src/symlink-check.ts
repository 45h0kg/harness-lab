import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { resolveInside } from "./sandbox.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
fs.symlinkSync("/etc", path.join(root, "etc-link"));
for (const p of ["notes/new.md", "etc-link/hosts", "etc-link/../../x", "/etc/hosts"]) {
  try { console.log(`ok      ${p} -> ${path.relative(fs.realpathSync(root), resolveInside(root, p))}`); }
  catch (e) { console.log(`refused ${p}: ${(e as Error).message}`); }
}
