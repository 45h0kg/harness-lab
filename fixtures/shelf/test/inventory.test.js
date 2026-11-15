import { test } from "node:test";
import assert from "node:assert/strict";
import { Inventory } from "../src/inventory.js";

test("reserve takes stock", () => {
  const inv = new Inventory();
  inv.receive("A", 3);
  inv.reserve("A", 2);
  assert.equal(inv.available("A"), 1);
  assert.throws(() => inv.reserve("A", 2), /only 1 of A/);
});
