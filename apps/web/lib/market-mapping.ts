import { yesMidpoint, yesPrice } from '@thesis/core';
import type { MarketDetail, MarketRow, ThesisMarkerRow } from '@thesis/db';
import type {
  ChartPoint,
  ChartSeries,
  GroupAverage,
  MarketDetailResponse,
  MarketView,
  ThesisMarker,
} from './market-view';

/** Turns database rows into what the Markets pages and API routes send. Server side. */

/**
 * An event's page on Gemini's site. Checked on 2026-11-18: this address with an event
 * ticker serves that event's page (for example /predictions/RECESSION26).
 */
export const GEMINI_EVENT_URL = 'https://www.gemini.com/predictions/';

export function toMarketView(row: MarketRow): MarketView {
  return {
    symbol: row.instrumentSymbol,
    eventTicker: row.eventTicker,
    title: row.title,
    contractLabel: row.contractLabel,
    category: row.category,
    expiryAt: row.expiryAt?.toISOString() ?? null,
    marketState: row.marketState,
    strike: row.strike,
    yesBid: row.yesBid,
    yesAsk: row.yesAsk,
    lastPrice: row.lastPrice,
    yesMid: yesMidpoint({ bid: row.yesBid, ask: row.yesAsk }),
    resolutionSide: row.resolutionSide,
    thesesYes: row.thesesYes,
    thesesNo: row.thesesNo,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The last plotted price at or before `t`, or the first one after it. Points are oldest first. */
function priceAt(points: readonly ChartPoint[], t: number): number | null {
  let found: number | null = null;
  for (const point of points) {
    if (point.t > t) return found ?? point.price;
    found = point.price;
  }
  return found;
}

function average(rows: readonly ThesisMarkerRow[], kind: ThesisMarkerRow['authorKind']): GroupAverage {
  const group = rows.filter((row) => row.authorKind === kind);
  if (group.length === 0) return { average: null, count: 0 };
  const sum = group.reduce((total, row) => total + Number(row.probabilityYes), 0);
  return { average: Math.round((sum / group.length) * 10_000) / 10_000, count: group.length };
}

/**
 * The chart's line: one series for the whole chart, never a mix.
 *
 * Normally it is the midpoints. A market maker replacing its quotes empties the book for an
 * instant, and falling back to the last trade there would draw a spike that never happened,
 * so a point without both sides is left out and the line holds its last value.
 *
 * A market whose book usually has one side empty has few midpoints or none, so it is drawn
 * from its last trade prices instead. "Usually" is a count over the points on the chart,
 * which keeps the choice steady from one refresh to the next.
 */
function toChartPoints(rows: MarketDetail['points']): { points: ChartPoint[]; series: ChartSeries } {
  const midpoints: ChartPoint[] = [];
  const trades: ChartPoint[] = [];
  let withoutMidpoint = 0;
  for (const row of rows) {
    const t = row.ts.getTime();
    const mid = yesMidpoint({ bid: row.yesBid, ask: row.yesAsk });
    if (mid === null) withoutMidpoint += 1;
    else midpoints.push({ t, price: mid });
    if (row.lastPrice !== null) trades.push({ t, price: Number(row.lastPrice) });
  }
  return midpoints.length >= withoutMidpoint || trades.length === 0
    ? { points: midpoints, series: 'midpoint' }
    : { points: trades, series: 'lastTrade' };
}

export function toMarketDetailView(detail: MarketDetail, asOf: Date): MarketDetailResponse {
  const market = toMarketView(detail.market);

  const { points, series } = toChartPoints(detail.points);

  const theses: ThesisMarker[] = detail.theses.map((row) => {
    const t = row.publishedAt?.getTime() ?? null;
    return {
      id: row.id,
      headline: row.headline,
      side: row.side,
      probabilityYes: Number(row.probabilityYes),
      authorKind: row.authorKind,
      authorName: row.authorName,
      t,
      price: t === null ? null : priceAt(points, t),
    };
  });

  return {
    asOf: asOf.toISOString(),
    market,
    points,
    series,
    theses,
    disagreement: {
      marketPrice: yesPrice({
        bid: detail.market.yesBid,
        ask: detail.market.yesAsk,
        last: detail.market.lastPrice,
      }),
      ai: average(detail.theses, 'agent'),
      human: average(detail.theses, 'human'),
    },
    geminiUrl: GEMINI_EVENT_URL + encodeURIComponent(market.eventTicker),
  };
}
