import { streamSymbolKey, type BookTicker, type GeminiPublicClient, type GeminiEvent } from '@thesis/core';
import { agentRuns, agentState, and, authors, desc, eq, gt, markets, type Db } from '@thesis/db';
import type { MomentumInput } from './momentum';
import { evaluateNews, newsMarketEligible, NewsForecastSchema, NEWS_INTERVAL_MS,
  NEWS_MAX_CALLS_PER_HOUR, type NewsResearchProvider, type NewsResearchRequest } from './news';

const key = 'news';
const text = (value: unknown) => (typeof value === 'string' ? value : value ? JSON.stringify(value) : '').slice(0, 8000);

function contractContext(event: GeminiEvent | null, symbol: string, nowMs: number): NewsResearchRequest | null {
  const contract = event?.contracts.find((c) => c.instrumentSymbol === symbol);
  if (!event || !contract || event.status !== 'active' || (contract.status ?? event.status) !== 'active' ||
      contract.marketState !== 'open' || contract.resolutionSide) return null;
  const expiry = Date.parse(contract.expiryDate ?? event.expiryDate ?? '');
  if (!Number.isFinite(expiry) || expiry - nowMs < 180_000) return null;
  const rules = text(contract.description).trim();
  if (!rules) return null;
  return { eventTicker: event.ticker, instrumentSymbol: symbol, title: event.title,
    contractLabel: contract.label ?? contract.ticker, description: text(event.description), rules,
    expiryAt: new Date(expiry).toISOString(), asOf: new Date(nowMs).toISOString() };
}

/** One research-only decision per 15 minutes. This component has no execution adapter. */
export function createNewsObserver(db: Db, client: Pick<GeminiPublicClient, 'getEvent'>, options: {
  enabled: () => boolean; provider?: NewsResearchProvider; now?: () => number; signal?: AbortSignal;
}) {
  const now = options.now ?? Date.now;
  const quotes = new Map<string, NonNullable<MomentumInput['quote']>>();
  let running = false;

  return {
    handleTicker(ticker: BookTicker, at = Date.now()) {
      quotes.set(ticker.symbolKey, { observedAtMs: at, bid: Number(ticker.bid), ask: Number(ticker.ask),
        bidSize: Number(ticker.bidSize), askSize: Number(ticker.askSize) });
      for (const [symbol, quote] of quotes) if (at - quote.observedAtMs > 60_000) quotes.delete(symbol);
    },

    async run(): Promise<number> {
      if (!options.enabled() || options.signal?.aborted || running) return 0;
      running = true;
      try {
        const reserved = await db.transaction(async (tx) => {
          await tx.insert(authors).values({ kind: 'agent', agentKey: key, displayName: 'News Research',
            strategySummary: 'Public evidence research; log-only forecasts, no executions.' }).onConflictDoNothing();
          await tx.select().from(authors).where(eq(authors.agentKey, key)).for('update');
          const at = now();
          const prior = await tx.select().from(agentRuns).where(eq(agentRuns.agentKey, key))
            .orderBy(desc(agentRuns.createdAt)).limit(200);
          if (prior[0] && at - prior[0].createdAt.getTime() < NEWS_INTERVAL_MS) return null;
          const halts = await tx.select().from(agentState).where(and(eq(agentState.agentKey, key), eq(agentState.halted, true)));
          const calls = prior.filter((r) => r.createdAt.getTime() > at - 60 * 60_000 && r.signal?.researchRequested === true);
          const candidates = (await tx.select().from(markets).where(and(eq(markets.tracked, true), gt(markets.expiryAt, new Date(at)))))
            .filter((market) => newsMarketEligible(market, at));
          const lastAttempt = (id: string) => prior.find((r) => r.marketId === id)?.createdAt.getTime() ?? 0;
          candidates.sort((a, b) => lastAttempt(a.id) - lastAttempt(b.id) ||
            a.expiryAt!.getTime() - b.expiryAt!.getTime() || a.id.localeCompare(b.id));
          const market = candidates[0];
          const reason = halts.length ? 'news agent halted' : !options.provider ? 'news research provider not configured' :
            calls.length >= NEWS_MAX_CALLS_PER_HOUR ? 'hourly research call limit' :
              !market ? 'no eligible news market' : 'news research reserved';
          const [run] = await tx.insert(agentRuns).values({ agentKey: key, marketId: market?.id ?? null,
            decision: 'skip', reason, createdAt: new Date(at),
            signal: { mode: 'log-only', phase: 'reserved', researchRequested: false } }).returning();
          if (!run || reason !== 'news research reserved' || !market) return { run, market: null };
          return { run, market };
        });
        if (!reserved) return 0;
        const { run, market } = reserved;
        if (!run || !market) return 1;
        const baseSignal = { mode: 'log-only', researchRequested: false };
        let researchRequested = false;
        try {
          const event = await client.getEvent(market.eventTicker);
          const context = event?.ticker === market.eventTicker ? contractContext(event, market.instrumentSymbol, now()) : null;
          if (!context) {
            await db.update(agentRuns).set({ reason: 'official market closed or missing contract rules',
              signal: { ...baseSignal, phase: 'skipped' } }).where(eq(agentRuns.id, run.id));
            return 1;
          }
          const abort = AbortSignal.any([AbortSignal.timeout(45_000), ...(options.signal ? [options.signal] : [])]);
          abort.throwIfAborted();
          researchRequested = true;
          await db.update(agentRuns).set({ reason: 'news research in progress',
            signal: { mode: 'log-only', phase: 'research', researchRequested } }).where(eq(agentRuns.id, run.id));
          // Provider adapters must pass this signal to their HTTP requests and return actual search provenance.
          let removeAbortListener = () => {};
          const cancelled = new Promise<never>((_, reject) => {
            const cancel = () => reject(abort.reason);
            abort.addEventListener('abort', cancel, { once: true });
            removeAbortListener = () => abort.removeEventListener('abort', cancel);
            if (abort.aborted) cancel();
          });
          const research = await Promise.race([
            Promise.resolve().then(() => { abort.throwIfAborted(); return options.provider!.research(context, abort); }), cancelled,
          ]).finally(removeAbortListener);
          abort.throwIfAborted();
          const refreshed = await client.getEvent(market.eventTicker);
          const finalContext = refreshed?.ticker === market.eventTicker ? contractContext(refreshed, market.instrumentSymbol, now()) : null;
          const [current] = await db.select().from(markets).where(eq(markets.id, market.id));
          const quote = quotes.get(streamSymbolKey(market.instrumentSymbol)) ?? null;
          const decision = !options.enabled() ? { decision: 'skip' as const, reason: 'news agent disabled during research' } :
            finalContext && current && newsMarketEligible(current, now()) ? evaluateNews({
            nowMs: now(), expiryMs: Date.parse(finalContext.expiryAt), marketState: 'open', quote, research,
          }) : { decision: 'skip' as const, reason: 'market became ineligible during research' };
          const parsed = NewsForecastSchema.safeParse(research.forecast);
          await db.update(agentRuns).set({
            reason: decision.decision === 'candidate' ? 'log only: hypothetical news entry' : decision.reason,
            signal: { mode: 'log-only', phase: 'completed', researchRequested, ...decision,
              forecast: parsed.success ? parsed.data : null, context,
              provider: research.provider.slice(0, 100), model: research.model.slice(0, 100),
              searchedAtMs: research.searchedAtMs, quote,
              audit: 'not performed; research citations are not a factual-accuracy audit' },
          }).where(eq(agentRuns.id, run.id));
        } catch (error) {
          const cancelled = options.signal?.aborted;
          await db.transaction(async (tx) => {
            await tx.select().from(authors).where(eq(authors.agentKey, key)).for('update');
            await tx.update(agentRuns).set({ reason: cancelled ? 'news research cancelled' : 'news research failed',
              error: cancelled ? null : error instanceof Error ? error.name.slice(0, 100) : 'ResearchError',
              signal: { mode: 'log-only', phase: cancelled ? 'cancelled' : 'failed', researchRequested },
            }).where(eq(agentRuns.id, run.id));
            const attempts = (await tx.select().from(agentRuns).where(eq(agentRuns.agentKey, key))
              .orderBy(desc(agentRuns.createdAt)).limit(200)).filter((r) => r.signal?.researchRequested === true).slice(0, 5);
            if (attempts.length === 5 && attempts.every((r) => r.error)) {
              await tx.insert(agentState).values({ agentKey: key, day: new Date(now()).toISOString().slice(0, 10),
                halted: true, haltReason: 'consecutive errors' }).onConflictDoUpdate({
                target: [agentState.agentKey, agentState.day], set: { halted: true, haltReason: 'consecutive errors' },
              });
            }
          });
        }
        return 1;
      } finally { running = false; }
    },
  };
}
