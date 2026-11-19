import type { SparkView } from './thesis-view';

/**
 * The short odds line on each post: what the side the author argued has cost, from a little
 * before they published until now (or until the market closed). Pure, so it is tested
 * without a database.
 */

const MINUTE = 60_000;

export interface SparkWindowInput {
  publishedAt: Date | null;
  expiryAt: Date | null;
  /** When a short crypto window opened. Nothing before it belongs to this contract. */
  opensAt: Date | null;
  now: Date;
}

/**
 * The line starts before publication by half the thesis's age (at least 15 minutes), so the
 * entry sits inside the line rather than at its edge, and ends now or at expiry.
 */
export function sparkWindow({ publishedAt, expiryAt, opensAt, now }: SparkWindowInput): { from: Date; to: Date } | null {
  if (!publishedAt) return null;
  const end = Math.min(now.getTime(), expiryAt?.getTime() ?? Number.POSITIVE_INFINITY);
  const age = Math.max(end - publishedAt.getTime(), 0);
  let from = publishedAt.getTime() - Math.max(age / 2, 15 * MINUTE);
  if (opensAt) from = Math.max(from, opensAt.getTime());
  if (!(end > from)) return null;
  return { from: new Date(from), to: new Date(end) };
}

export interface RecordedPoint {
  ts: Date;
  yesBid: string | null;
  yesAsk: string | null;
  lastPrice: string | null;
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * YES at each point is the midpoint when the book has both sides, otherwise the last trade.
 * A point with neither is skipped. The side's price is YES, or one minus YES for NO.
 */
export function toSpark(
  points: readonly RecordedPoint[],
  options: { side: 'yes' | 'no'; entryPrice: string | null; publishedAt: Date | null; from: Date; to: Date },
): SparkView | null {
  const series: SparkView['points'] = [];
  for (const point of points) {
    const bid = point.yesBid === null ? null : Number(point.yesBid);
    const ask = point.yesAsk === null ? null : Number(point.yesAsk);
    const yes = bid !== null && ask !== null ? (bid + ask) / 2 : point.lastPrice === null ? null : Number(point.lastPrice);
    if (yes === null || !Number.isFinite(yes)) continue;
    series.push({ t: point.ts.getTime(), p: round(options.side === 'yes' ? yes : 1 - yes) });
  }
  if (series.length < 2) return null;
  series.sort((a, b) => a.t - b.t);
  return {
    points: series,
    entryT: options.publishedAt?.getTime() ?? null,
    entryPrice: options.entryPrice === null ? null : Number(options.entryPrice),
    from: options.from.getTime(),
    to: options.to.getTime(),
  };
}

/** "25m", "3h", "2d": how long ago, for a post's header. */
export function ago(iso: string | null, now: Date): string {
  if (!iso) return '';
  const ms = Math.max(now.getTime() - Date.parse(iso), 0);
  if (ms < MINUTE) return 'now';
  if (ms < 60 * MINUTE) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < 24 * 60 * MINUTE) return `${Math.floor(ms / (60 * MINUTE))}h`;
  return `${Math.floor(ms / (24 * 60 * MINUTE))}d`;
}
