import { config } from "./config.js";

const SYMBOLS = { USD: "$", EUR: "€", GBP: "£" };

// Round a fractional number of cents to whole cents, half away from zero.
export function roundCents(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}

export function formatPrice(cents, currency = config.currency) {
  const symbol = SYMBOLS[currency] ?? currency + " ";
  const whole = Math.floor(Math.abs(cents) / 100);
  const frac = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${symbol}${whole}.${frac}`;
}
