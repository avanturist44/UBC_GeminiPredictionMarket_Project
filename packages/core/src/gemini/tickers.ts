/**
 * Gemini event tickers for recurring markets end in the expiry time as YYMMDDHHmm in UTC,
 * for example BTC15M2611170745. That makes the current and next events computable
 * without listing every event (the full list response is tens of megabytes).
 *
 * Contract symbols are never built here: use `instrumentSymbol` exactly as Gemini returns it.
 */

const MINUTE_MS = 60_000;

const pad = (value: number) => String(value).padStart(2, '0');

/** Formats a time as the YYMMDDHHmm suffix Gemini uses in tickers, in UTC. */
export function formatTickerTime(date: Date): string {
  return (
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes())
  );
}

export interface RollingSpec {
  /** Everything before the time suffix, for example "BTC15M" or "WXHIGH-NYC-". */
  prefix: string;
  /** Minutes between expiries: 15 for 15-minute windows, 1440 for daily events. */
  periodMinutes: number;
  /** Minutes after midnight UTC of the first expiry: 0 for windows, 1320 for 22:00 UTC. */
  offsetMinutes: number;
  /** How many upcoming events to return: 2 means "current and next". */
  count: number;
}

/** The next `count` expiries strictly after `now`. An event is over at its expiry instant. */
export function rollingExpiries(spec: RollingSpec, now: Date): Date[] {
  const period = spec.periodMinutes * MINUTE_MS;
  const offset = spec.offsetMinutes * MINUTE_MS;
  const first = (Math.floor((now.getTime() - offset) / period) + 1) * period + offset;
  return Array.from({ length: spec.count }, (_, i) => new Date(first + i * period));
}

export function rollingEventTickers(spec: RollingSpec, now: Date): string[] {
  return rollingExpiries(spec, now).map((expiry) => spec.prefix + formatTickerTime(expiry));
}
