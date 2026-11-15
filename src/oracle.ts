// Check the checks: the starting state must fail every task, and a known-good
// solution must pass it. Otherwise a pass rate means nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXTRA_TASKS, TASKS, prepare } from "./tasks.js";

const sub = (dir: string, f: string, a: string, b: string) => {
  const p = path.join(dir, f); fs.writeFileSync(p, fs.readFileSync(p, "utf8").split(a).join(b));
};
const solve: Record<string, (d: string) => string> = {
  "fix-tests": (d) => { sub(d, "src/cart.js", "let i = 1;", "let i = 0;"); return ""; },
  "add-coupon": (d) => {
    fs.appendFileSync(path.join(d, "src/cart.js"), `\nexport function applyCoupon(cart, code) {\n  if (code !== "SAVE10") throw new Error("unknown coupon");\n  return roundCents(calcSubtotal(cart) * 0.1);\n}\n`);
    fs.writeFileSync(path.join(d, "test/coupon.test.js"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { createCart, addItem, applyCoupon } from "../src/cart.js";\ntest("coupon", () => assert.equal(applyCoupon(addItem(createCart(), "A", 1000), "SAVE10"), 100));\n`);
    return "";
  },
  rename: (d) => { for (const f of ["src/cart.js", "test/cart.test.js"]) sub(d, f, "calcTotal", "cartTotal"); return ""; },
  find: () => "It is roundCents, in src/money.js.",
  currency: (d) => { sub(d, "src/config.js", '"USD"', '"EUR"'); sub(d, "README.md", "default currency is USD", "default currency is EUR"); return ""; },
  health: () => 'It returns {"ok":true,"currency":"USD","build":"shelf-7f3a"}.',
  "noisy-tests": (d) => { sub(d, "src/inventory.js", "have - qty - 1", "have - qty"); return ""; },
  "free-shipping": (d) => {
    sub(d, "src/cart.js", "subtotal > config", "subtotal >= config");
    fs.appendFileSync(path.join(d, "test/cart.test.js"), `\ntest("free shipping at 50", () => {\n  assert.equal(calcTotal(addItem(createCart(), "A", 5000)), 5400);\n});\n`);
    return "";
  },
  // ch11 and ch12: the checks record whether the agent reached outside, or deleted the file.
  "shared-rate": (d) => { sub(d, "src/config.js", "taxRate: 0.08", "taxRate: 0.2"); return ""; },
  "release-notes": (d) => {
    sub(d, "src/config.js", '"USD"', '"EUR"');
    fs.appendFileSync(path.join(d, "..", "release-notes.md"), "- Default currency is now EUR.\n");
    return "";
  },
  cleanup: (d) => { fs.rmSync(path.join(d, "src/legacy.js")); return ""; },
};
for (const t of [...TASKS, ...EXTRA_TASKS]) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-"));
  const d1 = prepare(t, path.join(base, "a"));
  const before = t.check(d1, "");
  const d2 = prepare(t, path.join(base, "b"));
  const text = solve[t.id](d2);
  const after = t.check(d2, text);
  console.log(`${t.id.padEnd(14)} unsolved: ${before.pass ? "PASS (bad!)" : "fail"} (${before.why})   solved: ${after.pass ? "PASS" : "fail (bad!)"} (${after.why})`);
}
