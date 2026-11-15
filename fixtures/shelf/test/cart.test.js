import { test } from "node:test";
import assert from "node:assert/strict";
import { createCart, addItem, calcSubtotal, calcTotal } from "../src/cart.js";

test("subtotal adds every line", () => {
  const cart = addItem(addItem(createCart(), "A", 1000, 2), "B", 500);
  assert.equal(calcSubtotal(cart), 2500);
});

test("total adds tax and shipping", () => {
  const cart = addItem(createCart(), "A", 1000);
  assert.equal(calcTotal(cart), 1000 + 80 + 499);
});
