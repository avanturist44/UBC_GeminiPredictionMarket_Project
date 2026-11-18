import type { Outcome } from './gemini/schemas';

/**
 * Exact arithmetic for prices, quantities and dollars, which travel as decimal strings.
 * Everything is held as a whole number of ten-thousandths (four decimal places, the
 * precision the database stores), so no float ever touches an order or a balance.
 */

const SCALE = 10_000n;
const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,4})0*)?$/;

/** "9.9979" becomes 99979n. Throws on anything that is not a decimal of at most four places. */
export function toUnits(value: string): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`not a decimal with at most four places: ${value}`);
  const [, sign, whole, fraction = ''] = match;
  const units = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(4, '0'));
  return sign === '-' ? -units : units;
}

/** 99979n becomes "9.9979". Always four decimal places. */
export function fromUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  return `${sign}${abs / SCALE}.${String(abs % SCALE).padStart(4, '0')}`;
}

/** What buying one contract of a side costs: the YES ask, or one dollar minus the YES bid. */
export function sideAsk(
  side: Outcome,
  quote: { yesBid: string | null; yesAsk: string | null },
): string | null {
  if (side === 'yes') return quote.yesAsk === null ? null : fromUnits(toUnits(quote.yesAsk));
  return quote.yesBid === null ? null : fromUnits(SCALE - toUnits(quote.yesBid));
}

export type OrderPlan =
  | { ok: true; quantity: string; costUsd: string }
  | { ok: false; code: 'bad_price' | 'below_minimum'; message: string };

/**
 * How many contracts a budget buys at a price: the budget divided by the price, rounded
 * down to the contract's quantity increment and to the size on offer, and refused if that
 * falls below the contract's minimum. Nothing is ever rounded up into a larger order.
 */
export function planOrder(input: {
  budgetUsd: string;
  price: string;
  quantityIncrement: string | null;
  quantityMinimum: string | null;
  /** Size on offer at this price. Null when it is not known. */
  availableQuantity?: string | null;
}): OrderPlan {
  const price = toUnits(input.price);
  if (price <= 0n || price >= SCALE) {
    return { ok: false, code: 'bad_price', message: 'The price must be between 0 and 1.' };
  }
  const step = toUnits(input.quantityIncrement ?? '0.01');
  const minimum = toUnits(input.quantityMinimum ?? '0.01');
  if (step <= 0n) return { ok: false, code: 'bad_price', message: 'The quantity increment is not usable.' };

  let quantity = (toUnits(input.budgetUsd) * SCALE) / price;
  if (input.availableQuantity != null) {
    const available = toUnits(input.availableQuantity);
    if (available < quantity) quantity = available;
  }
  quantity = (quantity / step) * step;
  if (quantity <= 0n || quantity < minimum) {
    return {
      ok: false,
      code: 'below_minimum',
      message: `That buys less than the smallest order of ${fromUnits(minimum)} contracts.`,
    };
  }
  // Quantity and price both move in hundredths, so the product is exact to four places.
  // If a contract ever breaks that, charge the next ten-thousandth up, never less.
  const product = quantity * price;
  const cost = product / SCALE + (product % SCALE === 0n ? 0n : 1n);
  return { ok: true, quantity: fromUnits(quantity), costUsd: fromUnits(cost) };
}
