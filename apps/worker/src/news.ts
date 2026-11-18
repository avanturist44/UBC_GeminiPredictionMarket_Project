import { z } from 'zod';
import type { MomentumInput } from './momentum';

export const NEWS_INTERVAL_MS = 15 * 60_000;
export const NEWS_MAX_CALLS_PER_HOUR = 4;
export const NEWS_RESEARCH_TIMEOUT_MS = 90_000;

export const NewsForecastSchema = z.strictObject({
  probability_yes: z.number().finite().min(0).max(1),
  confidence: z.enum(['low', 'medium', 'high']),
  headline: z.string().trim().min(1).max(90),
  body: z.string().trim().min(1).max(1200),
  evidence: z.array(z.strictObject({ claim: z.string().trim().min(1).max(500), url: z.url() })).max(8),
  no_trade_reason: z.string().trim().min(1).max(500).nullable(),
});
export type NewsForecast = z.infer<typeof NewsForecastSchema>;

export interface NewsResearchRequest {
  eventTicker: string;
  instrumentSymbol: string;
  title: string;
  contractLabel: string;
  description: string;
  rules: string;
  expiryAt: string;
  asOf: string;
}

/** URLs must come from actual search-tool results, not just the model's generated text. */
export interface NewsResearchResult {
  forecast: unknown;
  searchedAtMs: number;
  sources: Array<{ url: string; title: string }>;
  provider: string;
  model: string;
}
export interface NewsResearchProvider {
  research(request: NewsResearchRequest, signal: AbortSignal): Promise<NewsResearchResult>;
}

/** Normalize only presentation differences; do not silently match different query strings. */
export function newsSourceKey(value: string): { url: string; host: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') ||
        /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname) ||
        /\.(localhost|local|internal)$/.test(url.hostname)) return null;
    url.hash = '';
    return { url: url.href, host: url.hostname.toLowerCase().replace(/^www\./, '') };
  } catch { return null; }
}

export function newsMarketEligible(market: {
  eventTicker: string; category: string | null; tracked: boolean;
  status: string | null; marketState: string | null; expiryAt: Date | null;
}, nowMs: number): boolean {
  if (!market.tracked || market.status !== 'active' || market.marketState !== 'open' ||
      !market.expiryAt || market.expiryAt.getTime() - nowMs < 3 * 60_000) return false;
  // Keep the short crypto windows exclusively in the deterministic strategy.
  if (/^(BTC|ETH|SOL|XRP)(05M|15M)/i.test(market.eventTicker)) return false;
  if (market.category?.toLowerCase() === 'crypto') return /^(BTC|ETH)\d{10}$/.test(market.eventTicker);
  return !!market.category;
}

export type NewsDecision = { decision: 'skip'; reason: string } | {
  decision: 'candidate'; side: 'yes' | 'no'; probabilityYes: number;
  entryPrice: number; availableQuantity: number; edge: number; forecast: NewsForecast;
};

export function evaluateNews(input: {
  nowMs: number; expiryMs: number; marketState: string | null;
  quote: MomentumInput['quote']; research: NewsResearchResult;
}): NewsDecision {
  if (input.marketState !== 'open') return { decision: 'skip', reason: 'market not open' };
  if (!Number.isFinite(input.expiryMs) || input.expiryMs - input.nowMs < 3 * 60_000) {
    return { decision: 'skip', reason: 'outside entry window' };
  }
  const parsed = NewsForecastSchema.safeParse(input.research.forecast);
  if (!parsed.success) return { decision: 'skip', reason: 'invalid research output' };
  const forecast = parsed.data;
  if (forecast.no_trade_reason) return { decision: 'skip', reason: `research abstained: ${forecast.no_trade_reason}` };
  if (forecast.confidence === 'low') return { decision: 'skip', reason: 'low research confidence' };
  const age = input.nowMs - input.research.searchedAtMs;
  if (!Number.isFinite(age) || age < 0 || age > NEWS_INTERVAL_MS) return { decision: 'skip', reason: 'stale research' };
  const retrieved = new Set(input.research.sources.map((s) => newsSourceKey(s.url)?.url).filter(Boolean));
  const evidence = forecast.evidence.map((e) => newsSourceKey(e.url));
  if (evidence.some((source) => !source || !retrieved.has(source.url))) {
    return { decision: 'skip', reason: 'citation missing from retrieved sources' };
  }
  if (new Set(evidence.map((source) => source!.host)).size < 2) {
    return { decision: 'skip', reason: 'fewer than two source domains' };
  }
  const quote = input.quote;
  if (!quote || input.nowMs - quote.observedAtMs < 0 || input.nowMs - quote.observedAtMs > 10_000) {
    return { decision: 'skip', reason: 'missing or stale book' };
  }
  const { bid, ask, bidSize, askSize } = quote;
  if (![bid, ask, bidSize, askSize].every(Number.isFinite) || bid <= 0 || ask >= 1 ||
      ask < bid || bidSize <= 0 || askSize <= 0) return { decision: 'skip', reason: 'invalid or one-sided book' };
  if (ask - bid > 0.06 + 1e-12) return { decision: 'skip', reason: 'spread too wide' };
  const yesEdge = forecast.probability_yes - ask;
  const noAsk = 1 - bid;
  const noEdge = 1 - forecast.probability_yes - noAsk;
  const side = yesEdge >= noEdge ? 'yes' : 'no';
  const entryPrice = side === 'yes' ? ask : noAsk;
  const edge = Math.max(yesEdge, noEdge);
  if (edge < 0.10 - 1e-12) return { decision: 'skip', reason: 'edge below ten cents' };
  if (entryPrice < 0.05 || entryPrice > 0.95) return { decision: 'skip', reason: 'outside price band' };
  return { decision: 'candidate', side, probabilityYes: forecast.probability_yes, entryPrice,
    availableQuantity: side === 'yes' ? askSize : bidSize, edge, forecast };
}
