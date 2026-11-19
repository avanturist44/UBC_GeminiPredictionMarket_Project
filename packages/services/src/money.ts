/** Exact four-decimal arithmetic shared by every paper execution path. */
export function units(value: string): bigint {
  if (!/^-?\d+(\.\d{1,4})?$/.test(value)) throw new Error('unsupported decimal precision');
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const n = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  return negative ? -n : n;
}
export function decimal(n: bigint): string {
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}${abs / 10_000n}.${String(abs % 10_000n).padStart(4, '0')}`;
}
export function paperFill(price: number, available: number, increment: string | null,
  minimum: string | null, budget: bigint) {
  if (!Number.isFinite(price) || price < 0.05 || price > 0.95 || budget <= 0n) return null;
  const p = units(price.toFixed(4));
  if (Math.abs(Number(decimal(p)) - price) > 1e-10) return null;
  const step = increment ? units(increment) : 0n;
  const min = minimum ? units(minimum) : 0n;
  if (step <= 0n || min <= 0n || !Number.isFinite(available) || available <= 0) return null;
  const size = BigInt(Math.floor(available * 10_000 + 1e-8));
  const affordable = budget * 10_000n / p;
  const quantity = (size < affordable ? size : affordable) / step * step;
  if (quantity < min || quantity <= 0n || quantity * p % 10_000n !== 0n) return null;
  return { price: decimal(p), quantity: decimal(quantity), costUsd: decimal(quantity * p / 10_000n) };
}
