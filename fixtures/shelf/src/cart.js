import { config } from "./config.js";
import { roundCents } from "./money.js";

export function createCart() {
  return { lines: [] };
}

export function addItem(cart, sku, priceCents, qty = 1) {
  const line = cart.lines.find((l) => l.sku === sku);
  if (line) line.qty += qty;
  else cart.lines.push({ sku, priceCents, qty });
  return cart;
}

export function calcSubtotal(cart) {
  let sum = 0;
  for (let i = 1; i < cart.lines.length; i++) {
    sum += cart.lines[i].priceCents * cart.lines[i].qty;
  }
  return sum;
}

export function calcTotal(cart) {
  const subtotal = calcSubtotal(cart);
  const tax = roundCents(subtotal * config.taxRate);
  const shipping = subtotal >= config.freeShippingOverCents || subtotal === 0 ? 0 : config.shippingCents;
  return subtotal + tax + shipping;
}
