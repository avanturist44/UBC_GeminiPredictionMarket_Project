import { AGENT_LIMITS, agentLimitReason, type GeminiPublicClient } from '@thesis/core';
import { randomUUID } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { agentRuns, agentState, and, audits, authors, desc, eq, markets, sql, theses, trades, type Db } from '@thesis/db';
import { evaluateMomentum, type MomentumInput } from './momentum';

const key = 'momentum';
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
class QuoteChanged extends Error {}
/** Exact decimal conversion; refuse precision that the existing schema cannot store. */
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
  if (price < 0.05 || price > 0.95) return null;
  // Quotes and quantity increments must be representable exactly in the existing schema.
  const p = units(price.toFixed(4));
  if (Math.abs(Number(decimal(p)) - price) > 1e-10) return null;
  const step = increment ? units(increment) : 0n;
  const min = minimum ? units(minimum) : 0n;
  if (step <= 0n || min <= 0n || !Number.isFinite(available) || available <= 0) return null;
  const size = BigInt(Math.floor(available * 10_000 + 1e-8));
  const affordable = budget * 10_000n / p;
  const quantity = (size < affordable ? size : affordable) / step * step;
  // Only fill combinations whose exact cost fits the four-decimal money schema.
  if (quantity < min || quantity <= 0n || quantity * p % 10_000n !== 0n) return null;
  return { price: decimal(p), quantity: decimal(quantity), costUsd: decimal(quantity * p / 10_000n) };
}

export interface TradingAdapter {
  execute(marketId: string, getInput: () => MomentumInput): Promise<void>;
  settle(): Promise<number>;
}

export function createPaperAdapter(db: Db, client: Pick<GeminiPublicClient, 'getEvent'>,
  options: { enabled: () => boolean; now?: () => number; registrationRequired?: boolean }) : TradingAdapter {
  const now = options.now ?? Date.now;
  async function locked<T>(fn: (tx: Db, authorId: string) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.insert(authors).values({ kind: 'agent', agentKey: key, displayName: 'BTC Momentum',
        strategySummary: 'Paper BTC 15-minute probability model; zero fees.' }).onConflictDoNothing();
      // One durable lock serializes entries and settlements, even across UTC midnight/processes.
      const [author] = await tx.select().from(authors).where(eq(authors.agentKey, key)).for('update');
      if (!author) throw new Error('momentum author missing');
      return fn(tx, author.id);
    });
  }
  async function state(tx: Db, day: string) {
    await tx.insert(agentState).values({ agentKey: key, day }).onConflictDoNothing();
    const [row] = await tx.select().from(agentState).where(and(eq(agentState.agentKey, key), eq(agentState.day, day)));
    if (!row) throw new Error('momentum state missing');
    return row;
  }
  return {
    async execute(marketId, getInput) {
      try {
      await locked(async (tx, authorId) => {
        const day = dayOf(now());
        const current = await state(tx, day);
        const positions = await tx.select().from(trades).where(and(eq(trades.authorId, authorId), eq(trades.mode, 'paper')));
        const open = positions.filter((p) => p.status === 'filled' || p.status === 'partial');
        const exposure = open.reduce((sum, p) => sum + units(p.costUsd), 0n);
        const balance = AGENT_LIMITS.bankroll + positions.reduce((sum, p) =>
          p.status === 'settled' ? sum + units(p.payoutUsd ?? '0') - units(p.costUsd) : sum, 0n) - exposure;
        const errorHalts = await tx.select().from(agentState).where(and(eq(agentState.agentKey, key),
          eq(agentState.halted, true), eq(agentState.haltReason, 'consecutive errors')));
        let reason = agentLimitReason({ enabled: options.enabled(), halted: current.halted || errorHalts.length > 0,
          pnl: units(current.realizedPnlUsd), exposure, balance, tradeCount: current.tradeCount,
          hasPosition: positions.some((p) => p.marketId === marketId && p.status !== 'rejected') });
        const [market] = await tx.select().from(markets).where(eq(markets.id, marketId));
        // Read stream inputs only after acquiring the lock; a wait for Postgres cannot age a fill silently.
        const input = getInput();
        input.nowMs = now();
        input.expiryMs = market?.expiryAt?.getTime() ?? NaN;
        input.marketState = market?.marketState ?? null;
        input.strike = Number(market?.strike);
        const signal = evaluateMomentum(input);
        if (!market || !/^GEMI-BTC15M\d+-UP$/.test(market.instrumentSymbol) || !market.tracked ||
            market.status !== 'active') reason ??= 'market not active BTC';
        if (market?.sourceDetails?.agency !== 'lukka' || market.sourceDetails.index !== 'LS-LRRR-XBTUSD') {
          reason ??= 'unsupported BTC index source';
        }
        if (signal.decision === 'skip') reason ??= signal.reason;
        let fill = null;
        if (!reason && signal.decision === 'trade') {
          const budget = [AGENT_LIMITS.stake, AGENT_LIMITS.perTrade, AGENT_LIMITS.exposure - exposure, balance]
            .reduce((a, b) => a < b ? a : b);
          fill = paperFill(signal.entryPrice, signal.availableQuantity, market!.quantityIncrement, market!.quantityMinimum, budget);
          if (!fill) reason = 'price band or executable size limit';
        }
        if (units(current.realizedPnlUsd) <= -AGENT_LIMITS.dailyLoss) {
          await tx.update(agentState).set({ halted: true, haltReason: current.haltReason ?? 'daily loss stop' })
            .where(and(eq(agentState.agentKey, key), eq(agentState.day, day)));
        }
        if (reason) await tx.update(agentState).set({ openExposureUsd: decimal(exposure) })
          .where(and(eq(agentState.agentKey, key), eq(agentState.day, day)));
        if (!reason && fill && signal.decision === 'trade') {
          const thesisId = randomUUID();
          const hash = (text: string) => `0x${bytesToHex(keccak_256(new TextEncoder().encode(text)))}`;
          const headline = `BTC 15-minute: ${signal.side.toUpperCase()} (paper)`;
          const body = `Simulated trade; zero fees. BTC index ${input.indexPrice.toFixed(2)} versus strike ${input.strike.toFixed(2)}. ` +
            `${((input.expiryMs - input.nowMs) / 60_000).toFixed(1)} minutes remain. ` +
            `Using 30 one-minute log returns, volatility is ${input.volatilityPerMinute.toFixed(6)} per minute. ` +
            `The normal model estimates YES at ${(signal.probabilityYes * 100).toFixed(1)}%. ` +
            `${signal.side.toUpperCase()} costs ${fill.price}; estimated edge ${(signal.edge * 100).toFixed(1)} cents. ` +
            `Filled ${fill.quantity} contracts from the available top of book. This model is an estimate, not a guarantee.`;
          const evidence = [{ claim: 'Gemini market, strike and official resolution',
            url: `https://www.gemini.com/predictions/${market!.eventTicker}` }];
          const content = { headline, body, side: signal.side, probabilityYes: signal.probabilityYes.toFixed(4), evidence };
          await tx.insert(theses).values({ id: thesisId, authorId, marketId, ...content,
            onchainId: hash(thesisId), contentHash: hash(JSON.stringify(content)),
            entryPrice: fill.price, marketYesPriceAtPublish: input.quote!.ask.toFixed(4),
            status: options.registrationRequired ? 'auditing' : 'published', publishedAt: options.registrationRequired ? null : new Date(now()), createdAt: new Date(now()) });
          // The fixed template makes only numeric claims checked against the same executable input.
          // This is a code audit of recorded inputs, not a web fact-check or a profitability claim.
          await tx.insert(audits).values({ thesisId, verdict: 'pass', insideInfo: false,
            model: 'deterministic-btc-v1', createdAt: new Date(now()), claims: [{
              text: `BTC index ${input.indexPrice.toFixed(2)} versus strike ${input.strike.toFixed(2)}.`,
              status: 'supported', source_url: evidence[0]!.url,
              note: 'Checked in code against the fresh Gemini index and official contract metadata at entry.',
            }, {
              text: `${signal.side.toUpperCase()} entry at ${fill.price}; ${fill.quantity} contracts.`,
              status: 'supported', source_url: evidence[0]!.url,
              note: 'Checked in code against the executable book and exact paper-fill calculation. Probability and edge remain model estimates.',
            }] });
          await tx.insert(trades).values({ ...fill, thesisId, authorId, marketId, side: signal.side, mode: 'paper',
            isAuthorPosition: true, locked: true, status: 'filled', idempotencyKey: `paper:momentum:${marketId}`,
            createdAt: new Date(now()) });
          await tx.update(agentState).set({ tradeCount: current.tradeCount + 1,
            openExposureUsd: decimal(exposure + units(fill.costUsd)) })
            .where(and(eq(agentState.agentKey, key), eq(agentState.day, day)));
        }
        await tx.insert(agentRuns).values({ agentKey: key, marketId, decision: reason ? 'skip' : 'trade',
          reason: reason ?? 'simulated fill at executable book; zero fees',
          signal: { mode: 'paper', ...signal, input, fill: reason ? null : fill }, createdAt: new Date(now()) });
        if (!reason && fill && signal.decision === 'trade') {
          // A slow write must not commit an entry whose book expired or changed during the transaction.
          const latest = { ...getInput(), nowMs: now(), expiryMs: input.expiryMs,
            marketState: input.marketState, strike: input.strike };
          const checked = evaluateMomentum(latest);
          if (!options.enabled() || dayOf(now()) !== day || now() - input.nowMs > 10_000 ||
              now() - (input.quote?.observedAtMs ?? 0) > 10_000 ||
              now() - input.indexObservedAtMs > 10_000 || checked.decision !== 'trade' ||
              checked.side !== signal.side || Math.abs(checked.entryPrice - signal.entryPrice) > 1e-10 ||
              checked.availableQuantity < Number(fill.quantity)) {
            throw new QuoteChanged('book, signal, trading switch or UTC day changed before commit');
          }
        }
      });
      } catch (error) {
        if (!(error instanceof QuoteChanged)) throw error;
        await db.insert(agentRuns).values({ agentKey: key, marketId, decision: 'skip', reason: error.message,
          signal: { mode: 'paper' }, createdAt: new Date(now()) });
      }
    },

    async settle() {
      const pending = await db.select({ market: markets }).from(trades).innerJoin(markets, eq(trades.marketId, markets.id))
        .innerJoin(authors, eq(trades.authorId, authors.id)).where(and(eq(authors.agentKey, key),
          eq(trades.mode, 'paper'), eq(trades.status, 'filled')));
      let count = 0;
      for (const { market } of pending) {
        if (!market.expiryAt || market.expiryAt.getTime() > now()) continue;
        const event = await client.getEvent(market.eventTicker);
        if (event?.ticker !== market.eventTicker) continue;
        const contract = event?.contracts.find((c) => c.instrumentSymbol === market.instrumentSymbol);
        const side = contract?.resolutionSide;
        // Never infer an outcome from the index or local prices. Invalid events refund cost.
        const voided = event?.status === 'invalid' || contract?.status === 'invalid';
        if (!voided && side !== 'yes' && side !== 'no') continue;
        count += await locked(async (tx, authorId) => {
          const day = dayOf(now());
          const current = await state(tx, day);
          const fills = await tx.select().from(trades).where(and(eq(trades.authorId, authorId),
            eq(trades.marketId, market.id), eq(trades.mode, 'paper'), eq(trades.status, 'filled')));
          let pnl = units(current.realizedPnlUsd);
          for (const fill of fills) {
            const payout = voided ? units(fill.costUsd) : fill.side === side ? units(fill.quantity) : 0n;
            pnl += payout - units(fill.costUsd);
            await tx.update(trades).set({ status: 'settled', payoutUsd: decimal(payout) }).where(eq(trades.id, fill.id));
            if (fill.thesisId) await tx.update(theses).set({
              status: options.registrationRequired ? sql`case when ${theses.registerTx} is null then 'draft'::thesis_status else 'resolved'::thesis_status end` : 'resolved',
              outcome: voided ? 'void' : fill.side === side ? 'right' : 'wrong' }).where(eq(theses.id, fill.thesisId));
          }
          if (!fills.length) return 0;
          const open = await tx.select().from(trades).where(and(eq(trades.authorId, authorId),
            eq(trades.mode, 'paper'), eq(trades.status, 'filled')));
          await tx.update(agentState).set({ realizedPnlUsd: decimal(pnl),
            openExposureUsd: decimal(open.reduce((s, p) => s + units(p.costUsd), 0n)),
            halted: current.halted || pnl <= -AGENT_LIMITS.dailyLoss,
            haltReason: current.haltReason ?? (pnl <= -AGENT_LIMITS.dailyLoss ? 'daily loss stop' : null) })
            .where(and(eq(agentState.agentKey, key), eq(agentState.day, day)));
          await tx.update(markets).set({ status: voided ? 'invalid' : 'settled',
            resolutionSide: voided ? null : side,
            resolvedAt: contract?.resolvedAt ? new Date(contract.resolvedAt) : event?.resolvedAt ? new Date(event.resolvedAt) : new Date(now()),
          }).where(eq(markets.id, market.id));
          await tx.insert(agentRuns).values({ agentKey: key, marketId: market.id, decision: 'skip',
            reason: 'paper settlement', signal: { mode: 'paper', outcome: voided ? 'void' : side,
              source: 'Gemini getEvent', eventTicker: event!.ticker, pnlUsd: decimal(pnl) }, createdAt: new Date(now()) });
          return fills.length;
        });
      }
      return count;
    },
  };
}

/** Fail closed after five failures; the durable halt survives process restarts and UTC rollover. */
export async function recordMomentumError(db: Db, error: unknown, now = Date.now()) {
  await db.transaction(async (tx) => {
    await tx.insert(authors).values({ kind: 'agent', agentKey: key, displayName: 'BTC Momentum' }).onConflictDoNothing();
    await tx.select().from(authors).where(eq(authors.agentKey, key)).for('update');
    await tx.insert(agentRuns).values({ agentKey: key, decision: 'skip', reason: 'worker error',
      error: error instanceof Error ? error.message : String(error), createdAt: new Date(now) });
    const recent = await tx.select().from(agentRuns).where(eq(agentRuns.agentKey, key)).orderBy(desc(agentRuns.createdAt)).limit(5);
    if (recent.length === 5 && recent.every((run) => run.error)) {
      await tx.insert(agentState).values({ agentKey: key, day: dayOf(now), halted: true, haltReason: 'consecutive errors' })
        .onConflictDoUpdate({ target: [agentState.agentKey, agentState.day], set: { halted: true, haltReason: 'consecutive errors' } });
    }
  });
}
