import type { PortfolioData } from '@thesis/db';
import { equityAt, histories, pricer } from './equity';
import type { PortfolioPoint, PortfolioView } from './record-view';

/** Points on the account line. The database thins prices to the same number of slots. */
export const PORTFOLIO_SLOTS = 96;

const money = (value: number) => value.toFixed(2);
const cents = (value: number) => Math.round(value * 100) / 100;

export interface PositionMark {
  markPrice: string | null;
  valueUsd: string;
}

/**
 * A user's account over time, from their own positions and the prices recorded under them.
 * Pure: the same rows, cash and `now` give the same line.
 *
 * The account starts with the cash it holds now, plus everything its positions cost, less
 * every payout it has been paid. Trades and payouts are the only things that move paper
 * cash, so that is what it held before the first position. At any moment after, it is
 * worth that start, less what was paid for positions opened by then, plus what those
 * positions were worth then.
 */
export function buildPortfolio(
  data: PortfolioData,
  options: { now: Date; cashUsd: number; slots?: number },
): { view: PortfolioView; marks: Map<string, PositionMark> } {
  const now = options.now.getTime();
  const p = pricer(new Map(data.markets.map((m) => [m.id, m])), histories(data.prices), now);

  let start = options.cashUsd;
  for (const trade of data.trades) {
    start += Number(trade.costUsd);
    if (trade.status === 'settled' && trade.payoutUsd !== null) start -= Number(trade.payoutUsd);
  }

  const marks = new Map<string, PositionMark>();
  let openValue = 0;
  for (const trade of data.trades) {
    if (trade.status === 'settled') continue;
    const value = p.value(trade, now);
    const mark = p.mark(trade, now);
    openValue += value;
    marks.set(trade.id, { markPrice: mark === null ? null : mark.toFixed(4), valueUsd: money(value) });
  }

  const value = options.cashUsd + openValue;
  const points: PortfolioPoint[] = [];
  const since = data.since?.getTime() ?? null;
  if (since !== null && since < now) {
    const slots = Math.max(2, options.slots ?? PORTFOLIO_SLOTS);
    for (let i = 0; i <= slots; i += 1) {
      const t = i === slots ? now : Math.round(since + ((now - since) * i) / slots);
      // The last point is the headline figure itself, so the line ends where the number says.
      points.push({ t, v: cents(i === slots ? value : equityAt(data.trades, start, p, t)) });
    }
  }

  return {
    view: {
      valueUsd: money(value),
      startUsd: money(start),
      changeUsd: money(value - start),
      openValueUsd: money(openValue),
      since: data.since?.toISOString() ?? null,
      points,
    },
    marks,
  };
}
