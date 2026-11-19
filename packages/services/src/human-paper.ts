import WebSocket from 'ws';
import { bookTickerStream, parseStreamMessage, streamSymbolKey, type GeminiPublicClient } from '@thesis/core';
import { and, audits, authors, eq, gte, inArray, markets, theses, thesisJobs, thesisRegistrations, trades, users, type Db } from '@thesis/db';
import { decimal, paperFill, units } from './money';
import { PublicationError } from './publication';

export type ExecutableQuote = { symbol: string; bid: number; ask: number; bidSize: number; askSize: number;
  observedAtMs: number; marketObservedAtMs: number; status: string; marketState: string | null;
  expiryMs: number; quantityIncrement: string | null; quantityMinimum: string | null };
export type QuoteLease = { read: () => ExecutableQuote | null; close: () => void };

/** Keep the socket open through commit, so disconnection, age or changed size invalidates a fill. */
export async function openPublicationQuote(client: Pick<GeminiPublicClient, 'getEvent'>,
  market: { eventTicker: string; instrumentSymbol: string }, wsUrl = 'wss://ws.gemini.com'): Promise<QuoteLease> {
  const observedAt = Date.now();
  const event = await client.getEvent(market.eventTicker);
  const contract = event?.ticker === market.eventTicker ? event.contracts.find(c => c.instrumentSymbol === market.instrumentSymbol) : null;
  if (!contract || event?.status !== 'active') throw new PublicationError('market_unavailable');
  const expiryMs = new Date(contract.expiryDate ?? event.expiryDate ?? '').getTime();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let quote: ExecutableQuote | null = null;
    let ready = false;
    const close = () => { clearTimeout(timer); quote = null; ws.close(); };
    const timer = setTimeout(() => { close(); reject(new PublicationError('quote_unavailable')); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ id: 'publication', method: 'SUBSCRIBE', params: [bookTickerStream(market.instrumentSymbol)] })));
    ws.on('message', data => {
      const message = parseStreamMessage(data.toString());
      if (message.kind !== 'bookTicker' || message.ticker.symbolKey !== streamSymbolKey(market.instrumentSymbol)) return;
      const ticker = message.ticker;
      quote = ticker.bid !== null && ticker.ask !== null && ticker.bidSize !== null && ticker.askSize !== null ? {
        symbol: market.instrumentSymbol, bid: Number(ticker.bid), ask: Number(ticker.ask),
        bidSize: Number(ticker.bidSize), askSize: Number(ticker.askSize), observedAtMs: Date.now(),
        marketObservedAtMs: observedAt, status: contract.status ?? '', marketState: contract.marketState ?? null,
        expiryMs, quantityIncrement: contract.quantityIncrement ?? null, quantityMinimum: contract.quantityMinimum ?? null,
      } : null;
      if (!ready && quote) { ready = true; clearTimeout(timer); resolve({ read: () => quote, close }); }
    });
    ws.on('close', () => { quote = null; });
    ws.on('error', () => { quote = null; close(); if (!ready) reject(new PublicationError('quote_unavailable')); });
  });
}

export async function publishHuman(db: Db, thesisId: string, read: QuoteLease['read'], options: {
  enabled: () => boolean; now?: () => number; requireRegistration?: string;
}) {
  const now = options.now ?? Date.now;
  const [owner] = await db.select({ userId: authors.userId }).from(theses)
    .innerJoin(authors, eq(authors.id, theses.authorId)).where(eq(theses.id, thesisId));
  if (!owner?.userId) throw new PublicationError('session_required');
  return db.transaction(async tx => {
    const [user] = await tx.select().from(users).where(eq(users.id, owner.userId!)).for('update');
    const [thesis] = await tx.select().from(theses).where(eq(theses.id, thesisId)).for('update');
    if (!user || user.tradingMode !== 'paper' || !thesis) throw new PublicationError('session_required');
    const [existing] = await tx.select().from(trades).where(eq(trades.idempotencyKey, `paper:human:${thesisId}`));
    if (existing) return existing;
    const [job] = await tx.select().from(thesisJobs).where(eq(thesisJobs.thesisId, thesisId));
    const checked = await tx.select().from(audits).where(eq(audits.thesisId, thesisId));
    if (options.requireRegistration) {
      const [registration] = await tx.select().from(thesisRegistrations).where(eq(thesisRegistrations.thesisId, thesisId));
      if (!thesis.registerTx || !registration?.confirmedAt || registration.escrowAddress.toLowerCase() !== options.requireRegistration.toLowerCase()) throw new PublicationError('registration_required');
    }
    if (thesis.status !== 'auditing' || job?.status !== 'running' || !job.startedAt || now() - job.startedAt.getTime() >= 120_000 || !checked.length || checked.some(a => a.verdict === 'blocked')) {
      throw new PublicationError('audit_required');
    }
    const [market] = await tx.select().from(markets).where(eq(markets.id, thesis.marketId));
    const at = now();
    const valid = (q: ExecutableQuote | null): q is ExecutableQuote => !!q &&
      q.symbol === market?.instrumentSymbol && q.status === 'active' && q.marketState === 'open' &&
      Number.isFinite(q.expiryMs) && q.expiryMs - now() >= 120_000 &&
      now() - q.observedAtMs >= 0 && now() - q.observedAtMs <= 10_000 &&
      now() - q.marketObservedAtMs >= 0 && now() - q.marketObservedAtMs <= 10_000 &&
      q.bid > 0 && q.ask < 1 && q.ask >= q.bid && q.ask - q.bid <= 0.060000001;
    const quote = read();
    if (!options.enabled()) throw new PublicationError('trading_disabled');
    if (!market?.tracked || market.status !== 'active' || market.marketState !== 'open' || !valid(quote)) throw new PublicationError('quote_unavailable');
    if (thesis.side === 'yes' ? Number(thesis.probabilityYes) <= quote.ask : Number(thesis.probabilityYes) >= quote.bid) {
      throw new PublicationError('probability_side');
    }
    const spent = await tx.select().from(trades).where(and(eq(trades.userId, user.id), eq(trades.mode, 'paper'),
      gte(trades.createdAt, new Date(new Date(at).toISOString().slice(0, 10)))));
    const total = spent.filter(t => ['filled', 'partial', 'settled'].includes(t.status)).reduce((s, t) => s + units(t.costUsd), 0n);
    const stake = units(job.stakeUsd);
    if (stake > units(user.maxPerTradeUsd) || stake > 100_000n) throw new PublicationError('per_trade_limit');
    if (total + stake > units(user.dailyCopyCapUsd)) throw new PublicationError('daily_limit');
    if (stake > units(user.paperBalanceUsd)) throw new PublicationError('insufficient_balance');
    const fill = paperFill(thesis.side === 'yes' ? quote.ask : 1 - quote.bid,
      thesis.side === 'yes' ? quote.askSize : quote.bidSize, quote.quantityIncrement, quote.quantityMinimum, stake);
    if (!fill) throw new PublicationError('no_fill');
    await tx.update(users).set({ paperBalanceUsd: decimal(units(user.paperBalanceUsd) - units(fill.costUsd)) }).where(eq(users.id, user.id));
    const [trade] = await tx.insert(trades).values({ ...fill, userId: user.id, authorId: thesis.authorId,
      marketId: thesis.marketId, thesisId, isAuthorPosition: true, locked: true, side: thesis.side,
      mode: 'paper', status: 'filled', idempotencyKey: `paper:human:${thesisId}`, createdAt: new Date(at) }).returning();
    await tx.update(theses).set({ status: 'published', publishedAt: new Date(at), entryPrice: fill.price,
      marketYesPriceAtPublish: quote.ask.toFixed(4) }).where(eq(theses.id, thesisId));
    const latest = read();
    if (!options.enabled() || !valid(latest) || latest.bid !== quote.bid || latest.ask !== quote.ask ||
      (thesis.side === 'yes' ? latest.askSize : latest.bidSize) < Number(fill.quantity) ||
      new Date(now()).toISOString().slice(0, 10) !== new Date(at).toISOString().slice(0, 10)) throw new PublicationError('quote_changed');
    return trade!;
  });
}

export async function settleHumans(db: Db, client: Pick<GeminiPublicClient, 'getEvent'>, now = Date.now()) {
  const pending = await db.select({ trade: trades, market: markets }).from(trades)
    .innerJoin(authors, eq(authors.id, trades.authorId)).innerJoin(markets, eq(markets.id, trades.marketId))
    .where(and(eq(authors.kind, 'human'), eq(trades.mode, 'paper'), eq(trades.status, 'filled'))).limit(100);
  let settled = 0;
  for (const { trade, market } of pending) {
    if (!trade.userId || !market.expiryAt || market.expiryAt.getTime() > now) continue;
    const event = await client.getEvent(market.eventTicker);
    if (event?.ticker !== market.eventTicker) continue;
    const contract = event.contracts.find(c => c.instrumentSymbol === market.instrumentSymbol);
    if (!contract) continue;
    const voided = event.status === 'invalid' || contract.status === 'invalid';
    const side = contract.resolutionSide;
    if (!voided && side !== 'yes' && side !== 'no') continue;
    settled += await db.transaction(async tx => {
      const [user] = await tx.select().from(users).where(eq(users.id, trade.userId!)).for('update');
      const [current] = await tx.select().from(trades).where(eq(trades.id, trade.id));
      if (!user || current?.status !== 'filled') return 0;
      const payout = voided ? units(current.costUsd) : current.side === side ? units(current.quantity) : 0n;
      await tx.update(users).set({ paperBalanceUsd: decimal(units(user.paperBalanceUsd) + payout) }).where(eq(users.id, user.id));
      await tx.update(trades).set({ status: 'settled', payoutUsd: decimal(payout) }).where(eq(trades.id, trade.id));
      if (trade.thesisId) await tx.update(theses).set({ status: 'resolved', outcome: voided ? 'void' : current.side === side ? 'right' : 'wrong' }).where(eq(theses.id, trade.thesisId));
      await tx.update(markets).set({ status: voided ? 'invalid' : 'settled', resolutionSide: voided ? null : side,
        resolvedAt: new Date(contract.resolvedAt ?? event.resolvedAt ?? now) }).where(eq(markets.id, market.id));
      return 1;
    });
  }
  return settled;
}
