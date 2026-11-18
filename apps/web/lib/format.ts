/**
 * How numbers and times are shown: prices in whole cents, probabilities in whole percent.
 * Display only. Nothing here is used to compute an order or a balance.
 */

const DASH = '–';

/**
 * A value between 0 and 1 as a whole number of hundredths, half rounding up. It rounds to
 * four decimals first: 0.285 * 100 is 28.499999999999996 in floating point, and would
 * otherwise show as 28 while 0.505 shows as 51.
 */
function hundredths(value: string | number): number {
  return Math.round(Math.round(Number(value) * 10_000) / 100);
}

/** A price between 0 and 1, as whole cents. */
export function cents(price: string | number | null): string {
  if (price === null) return DASH;
  return `${hundredths(price)}¢`;
}

/** A probability between 0 and 1, as a whole percentage. */
export function percent(probability: string | number | null): string {
  if (probability === null) return DASH;
  return `${hundredths(probability)}%`;
}

/** What buying NO costs: one dollar minus the YES bid, which is how Gemini quotes it. */
export function noBuyPrice(yesBid: string | null): number | null {
  if (yesBid === null) return null;
  return Math.round((1 - Number(yesBid)) * 10_000) / 10_000;
}

export interface TimeLeft {
  text: string;
  /** Under an hour: shown as a running countdown. */
  soon: boolean;
  over: boolean;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Time until a market closes: a countdown under an hour, coarser beyond that. */
export function timeLeft(expiry: Date | null, now: Date): TimeLeft {
  if (expiry === null) return { text: 'No end date', soon: false, over: false };
  const ms = expiry.getTime() - now.getTime();
  if (ms <= 0) return { text: 'Closed', soon: false, over: true };
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    const seconds = Math.floor((ms % MINUTE) / SECOND);
    return { text: `${minutes}:${String(seconds).padStart(2, '0')}`, soon: true, over: false };
  }
  if (ms < 2 * DAY) {
    return {
      text: `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`,
      soon: false,
      over: false,
    };
  }
  return { text: `${Math.floor(ms / DAY)} days`, soon: false, over: false };
}

/** Dollars of test money: "4.9995" becomes "$5.00". */
export function usd(amount: string | number | null): string {
  if (amount === null) return DASH;
  return `$${Number(amount).toFixed(2)}`;
}

/** Contracts, without trailing zeros: "9.0900" becomes "9.09". */
export function contracts(quantity: string): string {
  return String(Number(quantity));
}

/** A number such as a strike, with thousands separators: 64931.38 becomes 64,931.38. */
export function plainNumber(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return number.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

const TICK_STEPS = [
  MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY,
];

/**
 * Tick times for a chart's time axis: at most `max` of them, on round steps (every 5
 * minutes, every hour, every day) inside the range. Times are milliseconds.
 */
export function timeTicks(from: number, to: number, max = 5): number[] {
  if (!(to > from)) return [];
  const step =
    TICK_STEPS.find((s) => (to - from) / s <= max) ??
    // Longer than any listed step covers: whole multiples of 30 days.
    Math.ceil((to - from) / max / (30 * DAY)) * 30 * DAY;
  const ticks: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push(t);
  return ticks;
}
