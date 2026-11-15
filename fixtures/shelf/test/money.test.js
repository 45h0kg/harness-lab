import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPrice, roundCents } from "../src/money.js";

test("formatPrice", () => {
  assert.equal(formatPrice(1999, "USD"), "$19.99");
  assert.equal(formatPrice(5, "EUR"), "€0.05");
  assert.equal(formatPrice(-250, "GBP"), "-£2.50");
});

test("roundCents", () => {
  assert.equal(roundCents(10.5), 11);
  assert.equal(roundCents(-10.5), -11);
});
