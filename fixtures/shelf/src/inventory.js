export class Inventory {
  constructor() {
    this.stock = new Map();
  }
  receive(sku, qty) {
    this.stock.set(sku, (this.stock.get(sku) ?? 0) + qty);
  }
  available(sku) {
    return this.stock.get(sku) ?? 0;
  }
  reserve(sku, qty) {
    const have = this.available(sku);
    if (qty > have) throw new Error(`only ${have} of ${sku} in stock`);
    this.stock.set(sku, have - qty);
  }
}
