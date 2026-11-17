import {
  resolveEventTickers,
  selectContracts,
  yesQuote,
  type GeminiContract,
  type GeminiEvent,
  type GeminiPublicClient,
  type TrackedRule,
} from '@thesis/core';
import {
  insertPricePoint,
  listTrackedSymbolsForEvent,
  upsertMarket,
  type Db,
  type MarketUpsert,
} from '@thesis/db';

/**
 * Worker job 1, minimal Phase 0 version: every cycle, fetch each tracked event from
 * Gemini's public REST API, keep its tracked contracts in `markets`, and write one
 * `price_points` row per contract that has a price.
 *
 * Phase 1 adds the WebSocket bookTicker stream on top; this poll stays as the fallback.
 */

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface RecorderDeps {
  db: Db;
  client: Pick<GeminiPublicClient, 'getEvent'>;
  rules: readonly TrackedRule[];
  now?: () => Date;
  logger?: Logger;
}

export interface CycleSummary {
  /** Events requested from Gemini. */
  events: number;
  /** Events Gemini does not list, for example tomorrow's daily event before it is created. */
  missing: number;
  /** Contracts inserted or refreshed in `markets`. */
  markets: number;
  /** Rows written to `price_points`. */
  points: number;
  /** Events that failed. They are retried on the next cycle. */
  errors: number;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toMarketUpsert(
  event: GeminiEvent,
  contract: GeminiContract,
  rule: TrackedRule,
): MarketUpsert {
  const quote = yesQuote(contract);
  return {
    instrumentSymbol: contract.instrumentSymbol,
    eventTicker: event.ticker,
    contractTicker: contract.ticker,
    title: event.title,
    contractLabel: contract.label ?? null,
    category: event.category ?? null,
    expiryAt: toDate(contract.expiryDate) ?? toDate(event.expiryDate),
    status: contract.status ?? event.status,
    marketState: contract.marketState ?? null,
    strike: contract.strike?.value ?? null,
    yesBid: quote.bid,
    yesAsk: quote.ask,
    lastPrice: quote.last,
    keywords: rule.keywords,
    quantityIncrement: contract.quantityIncrement ?? null,
    quantityMinimum: contract.quantityMinimum ?? null,
    priceIncrement: contract.priceIncrement ?? null,
    sourceDetails: event.sourceDetails
      ? { agency: event.sourceDetails.agency ?? null, index: event.sourceDetails.index ?? null }
      : null,
  };
}

export async function runRecorderCycle(deps: RecorderDeps): Promise<CycleSummary> {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  const summary: CycleSummary = { events: 0, missing: 0, markets: 0, points: 0, errors: 0 };
  const cycleStart = now();

  for (const rule of deps.rules) {
    for (const eventTicker of resolveEventTickers(rule, cycleStart)) {
      summary.events += 1;
      try {
        const event = await deps.client.getEvent(eventTicker);
        if (!event) {
          summary.missing += 1;
          logger.warn(`recorder: Gemini does not list ${eventTicker} (rule ${rule.key})`);
          continue;
        }
        const observedAt = now();
        const pinned = await listTrackedSymbolsForEvent(deps.db, eventTicker);
        for (const contract of selectContracts(event, rule.pick, pinned)) {
          const market = toMarketUpsert(event, contract, rule);
          const { id } = await upsertMarket(deps.db, market);
          summary.markets += 1;
          if (market.yesBid === null && market.yesAsk === null && market.lastPrice === null) continue;
          await insertPricePoint(deps.db, {
            marketId: id,
            ts: observedAt,
            yesBid: market.yesBid,
            yesAsk: market.yesAsk,
            lastPrice: market.lastPrice,
            source: 'rest',
          });
          summary.points += 1;
        }
      } catch (error) {
        summary.errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`recorder: ${eventTicker} (rule ${rule.key}) failed: ${message}`);
      }
    }
  }
  return summary;
}
