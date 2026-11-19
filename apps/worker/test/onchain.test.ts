import { marketOnchainId } from '@thesis/core';
import {
  authors,
  createGuestUser,
  ensureAgentAuthor,
  ensureHumanAuthor,
  eq,
  markets,
  theses,
  tips,
  upsertMarket,
  users,
  type Db,
  type MarketUpsert,
} from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EscrowChain } from '../src/chain';
import type { CircleTx, CircleWallets } from '../src/circle';
import { ALREADY_ONCHAIN, createOnchain, stableKey } from '../src/onchain';

const SYMBOL = 'GEMI-BRENT2611182200-HI90';
const ESCROW = '0x00000000000000000000000000000000000e5c20';
const USDC = '0x3600000000000000000000000000000000000000';

const market = (overrides: Partial<MarketUpsert> = {}): MarketUpsert => ({
  instrumentSymbol: SYMBOL,
  eventTicker: 'BRENT2611182200',
  contractTicker: 'HI90',
  title: 'Oil (Brent) price on November 18?',
  contractLabel: '$90 or above',
  category: 'Commodities',
  expiryAt: new Date('2026-11-18T22:00:00Z'),
  status: 'active',
  marketState: 'open',
  strike: '90',
  yesBid: '0.60',
  yesAsk: '0.62',
  lastPrice: null,
  keywords: [],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: null,
  ...overrides,
});

/** A stand-in for the contract and the token: enough state to behave like them. */
function fakeChain() {
  const state = {
    theses: new Map<string, { author: string; sideYes: boolean; settled: boolean }>(),
    markets: new Map<string, 'yes' | 'no' | 'void'>(),
    held: new Map<string, bigint>(),
    balances: new Map<string, bigint>(),
    allowances: new Map<string, bigint>(),
    calls: [] as string[],
    failNext: null as string | null,
  };
  const write = (name: string) => {
    state.calls.push(name);
    if (state.failNext === name) {
      state.failNext = null;
      throw new Error(`${name} reverted`);
    }
    return `0x${name}${state.calls.length}` as `0x${string}`;
  };
  const chain: EscrowChain = {
    escrowAddress: ESCROW,
    usdcAddress: USDC,
    async thesis(id) {
      const t = state.theses.get(id);
      return t ? { author: t.author as `0x${string}`, marketId: '0x', contentHash: '0x', expiry: 0n, sideYes: t.sideYes, settled: t.settled, totalTips: 0n } : null;
    },
    async marketState(marketId) {
      const m = state.markets.get(marketId);
      return m === 'yes' ? 'yesWon' : m === 'no' ? 'noWon' : m === 'void' ? 'void' : 'open';
    },
    tipOf: async (id, tipper) => state.held.get(`${id}:${tipper}`) ?? 0n,
    usdcBalance: async (owner) => state.balances.get(owner) ?? 0n,
    usdcAllowance: async (owner) => state.allowances.get(owner) ?? 0n,
    async registerThesis(input) {
      if (state.theses.has(input.id)) return null;
      const hash = write('register');
      state.theses.set(input.id, { author: input.author, sideYes: input.sideYes, settled: false });
      return hash;
    },
    async reportOutcome(marketId, outcome) {
      if (state.markets.has(marketId)) return null;
      const hash = write('report');
      state.markets.set(marketId, outcome);
      return hash;
    },
    async settle(id) {
      const t = state.theses.get(id);
      if (!t || t.settled) return null;
      const hash = write('settle');
      t.settled = true;
      return hash;
    },
    async refund(id, tipper) {
      const key = `${id}:${tipper}`;
      if (!state.held.get(key)) return null;
      const hash = write('refund');
      state.held.set(key, 0n);
      return hash;
    },
  };
  return { chain, state };
}

/** A stand-in for Circle. Transactions finish when the test says so. */
function fakeCircle(chainState: ReturnType<typeof fakeChain>['state']) {
  const txs = new Map<string, { kind: string; done: () => void; state: CircleTx['state']; error?: string }>();
  const sent: Array<{ kind: string; key: string }> = [];
  let wallets = 0;
  let auto = true;
  const start = (kind: string, key: string, done: () => void): string => {
    const id = `tx-${key}`;
    if (!txs.has(id)) {
      sent.push({ kind, key });
      txs.set(id, { kind, done, state: 'pending' });
      if (auto) finish(id);
    }
    return id;
  };
  const finish = (id: string) => {
    const tx = txs.get(id)!;
    tx.done();
    tx.state = 'complete';
  };
  const circle: CircleWallets = {
    async createWallet() {
      wallets += 1;
      return { walletId: `wallet-${wallets}`, address: `0x${String(wallets).padStart(40, '0')}` };
    },
    async fundFromTreasury(address, amount, key) {
      return start('fund', key, () => chainState.balances.set(address, (chainState.balances.get(address) ?? 0n) + BigInt(Number(amount) * 1e6)));
    },
    async execute(input) {
      const address = `0x${input.walletId.replace('wallet-', '').padStart(40, '0')}`;
      if (input.abiFunctionSignature.startsWith('approve')) {
        return start('approve', input.idempotencyKey, () => chainState.allowances.set(address, BigInt(input.abiParameters[1]!)));
      }
      return start('tip', input.idempotencyKey, () => {
        const amount = BigInt(input.abiParameters[1]!);
        chainState.balances.set(address, (chainState.balances.get(address) ?? 0n) - amount);
        const key = `${input.abiParameters[0]}:${address}`;
        chainState.held.set(key, (chainState.held.get(key) ?? 0n) + amount);
      });
    },
    async transaction(id) {
      const tx = txs.get(id);
      if (!tx) return { state: 'failed', txHash: null, error: 'unknown transaction' };
      return { state: tx.state, txHash: tx.state === 'complete' ? `0xhash-${tx.kind}` : null, error: tx.error ?? null };
    },
  };
  return {
    circle,
    sent,
    finishAll: () => [...txs.keys()].forEach((id) => txs.get(id)!.state === 'pending' && finish(id)),
    fail: (kind: string, error: string) => {
      for (const tx of txs.values()) if (tx.kind === kind && tx.state === 'pending') Object.assign(tx, { state: 'failed', error });
    },
    manual: () => {
      auto = false;
    },
    walletCount: () => wallets,
  };
}

let db: Db;
let close: () => Promise<void>;
let marketId: string;
let seq = 0;
const logs: string[] = [];
const logger = { info: () => {}, warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ id: marketId } = await upsertMarket(db, market()));
  logs.length = 0;
});
afterEach(() => close());

async function thesisBy(authorId: string, extra: Partial<typeof theses.$inferInsert> = {}) {
  seq += 1;
  const [row] = await db
    .insert(theses)
    .values({
      onchainId: `0x${String(seq).padStart(64, '0')}`,
      contentHash: `0x${'c'.repeat(64)}`,
      authorId,
      marketId,
      side: 'yes',
      probabilityYes: '0.7',
      headline: 'h',
      body: 'b',
      status: 'published',
      registerTx: '0xregistered',
      ...extra,
    })
    .returning();
  return row!;
}
const tipRow = async (thesisId: string, userId: string, amountUsdc = '0.25') =>
  (await db.insert(tips).values({ thesisId, userId, amountUsdc }).returning())[0]!;
const tipsOf = (thesisId: string) => db.select().from(tips).where(eq(tips.thesisId, thesisId));

function setup() {
  const { chain, state } = fakeChain();
  const circleFake = fakeCircle(state);
  const onchain = createOnchain({ db, chain, circle: circleFake.circle, logger });
  return { onchain, state, ...circleFake };
}

describe('register', () => {
  it('gives a person a wallet, records the thesis under it, and returns the transaction', async () => {
    const { onchain, state, walletCount } = setup();
    const user = await createGuestUser(db, 'Sam');
    const author = await ensureHumanAuthor(db, user);
    const thesis = await thesisBy(author.id, { registerTx: null, side: 'no' });
    const [stored] = await db.select().from(markets).where(eq(markets.id, marketId));

    const hash = await onchain.register({ thesis, author, market: stored! });
    expect(hash).toBe('0xregister1');
    expect(state.theses.get(thesis.onchainId)).toMatchObject({ sideYes: false, author: '0x0000000000000000000000000000000000000001' });
    // The same wallet is the user's tipping wallet and the author's payout address.
    expect((await db.select().from(users))[0]).toMatchObject({ circleWalletId: 'wallet-1', walletAddress: '0x0000000000000000000000000000000000000001' });
    expect((await db.select().from(authors))[0]).toMatchObject({ walletAddress: '0x0000000000000000000000000000000000000001' });
    expect(walletCount()).toBe(1);
  });

  it('gives an agent a payout wallet once, and reuses it', async () => {
    const { onchain, walletCount } = setup();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const [stored] = await db.select().from(markets);
    await onchain.register({ thesis: await thesisBy(author.id, { registerTx: null }), author, market: stored! });
    const [again] = await db.select().from(authors);
    const other = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-OTHER-X' }));
    await onchain.register({ thesis: await thesisBy(again!.id, { registerTx: null, marketId: other.id }), author: again!, market: stored! });
    expect(walletCount()).toBe(1);
  });

  it('sends nothing for a thesis the contract already has, and says so', async () => {
    const { onchain, state } = setup();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const thesis = await thesisBy(author.id, { registerTx: null });
    const [stored] = await db.select().from(markets);
    await onchain.register({ thesis, author, market: stored! });
    expect(await onchain.register({ thesis, author: (await db.select().from(authors))[0]!, market: stored! })).toBe(ALREADY_ONCHAIN);
    expect(state.calls).toEqual(['register']);
  });
});

describe('runTipCycle', () => {
  it('makes the wallet, funds it once, approves the escrow, sends the tip, and marks it escrowed', async () => {
    const { onchain, state, sent, manual, finishAll } = setup();
    manual();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const thesis = await thesisBy(author.id);
    const tipper = await createGuestUser(db, 'Tipper');
    const tip = await tipRow(thesis.id, tipper.id);

    // Each cycle moves one step, waiting on Circle in between.
    expect(await onchain.runTipCycle()).toEqual({ escrowed: 0, failed: 0, waiting: 1 });
    expect(sent.map((s) => s.kind)).toEqual(['fund']);
    await onchain.runTipCycle();
    expect(sent.map((s) => s.kind)).toEqual(['fund']);
    finishAll();
    await onchain.runTipCycle();
    expect(sent.map((s) => s.kind)).toEqual(['fund', 'approve']);
    finishAll();
    await onchain.runTipCycle();
    expect(sent.map((s) => s.kind)).toEqual(['fund', 'approve', 'tip']);
    expect((await tipsOf(thesis.id))[0]).toMatchObject({ status: 'pending', circleTxId: `tx-${stableKey(`tip:${tip.id}`)}` });
    finishAll();
    expect(await onchain.runTipCycle()).toEqual({ escrowed: 1, failed: 0, waiting: 0 });

    expect((await tipsOf(thesis.id))[0]).toMatchObject({ status: 'escrowed', depositTx: '0xhash-tip' });
    const address = '0x0000000000000000000000000000000000000001';
    expect(state.held.get(`${thesis.onchainId}:${address}`)).toBe(250_000n);
    expect(state.balances.get(address)).toBe(1_750_000n);
  });

  it('does not fund or approve again for a second tip from the same wallet', async () => {
    const { onchain, sent } = setup();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const tipper = await createGuestUser(db, 'Tipper');
    const first = await thesisBy(author.id);
    await tipRow(first.id, tipper.id, '0.50');
    for (let i = 0; i < 3; i += 1) await onchain.runTipCycle();
    const other = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-OTHER-X' }));
    const second = await thesisBy(author.id, { marketId: other.id });
    await tipRow(second.id, tipper.id, '0.10');
    for (let i = 0; i < 3; i += 1) await onchain.runTipCycle();
    expect(sent.map((s) => s.kind)).toEqual(['fund', 'approve', 'tip', 'tip']);
    expect((await db.select().from(tips)).map((t) => t.status)).toEqual(['escrowed', 'escrowed']);
  });

  it('sends one tip per tip row, however often the cycle is repeated or restarted', async () => {
    const { chain, state } = fakeChain();
    const circleFake = fakeCircle(state);
    circleFake.manual();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const thesis = await thesisBy(author.id);
    const tipper = await createGuestUser(db, 'Tipper');
    await tipRow(thesis.id, tipper.id);
    // A new job object each cycle, as after a restart: nothing is remembered in memory.
    for (let i = 0; i < 8; i += 1) {
      await createOnchain({ db, chain, circle: circleFake.circle, logger }).runTipCycle();
      circleFake.finishAll();
    }
    expect(circleFake.sent.filter((s) => s.kind === 'tip')).toHaveLength(1);
    expect(circleFake.sent.filter((s) => s.kind === 'fund')).toHaveLength(1);
    expect(state.held.get(`${thesis.onchainId}:0x0000000000000000000000000000000000000001`)).toBe(250_000n);
  });

  it('fails a tip on a thesis that was never registered, without touching a wallet', async () => {
    const { onchain, sent } = setup();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const thesis = await thesisBy(author.id, { registerTx: null });
    const tipper = await createGuestUser(db, 'Tipper');
    await tipRow(thesis.id, tipper.id);
    expect(await onchain.runTipCycle()).toEqual({ escrowed: 0, failed: 1, waiting: 0 });
    expect((await tipsOf(thesis.id))[0]).toMatchObject({ status: 'failed' });
    expect(sent).toEqual([]);
  });

  it('marks the tip failed when Circle reports the transaction failed', async () => {
    const { onchain, manual, finishAll, fail } = setup();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const thesis = await thesisBy(author.id);
    const tipper = await createGuestUser(db, 'Tipper');
    await tipRow(thesis.id, tipper.id);
    manual();
    await onchain.runTipCycle();
    finishAll();
    await onchain.runTipCycle();
    finishAll();
    // The tip itself is now with Circle, and Circle reports that it reverted.
    await onchain.runTipCycle();
    fail('tip', 'execution reverted: expired');
    expect(await onchain.runTipCycle()).toMatchObject({ failed: 1 });
    expect((await tipsOf(thesis.id))[0]).toMatchObject({ status: 'failed' });
    expect(logs.join('\n')).toContain('expired');
    finishAll();
  });

  it('fails a tip the wallet cannot cover once its welcome money is spent', async () => {
    const { onchain, state } = setup();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const thesis = await thesisBy(author.id);
    const tipper = await createGuestUser(db, 'Tipper');
    await tipRow(thesis.id, tipper.id, '0.50');
    for (let i = 0; i < 3; i += 1) await onchain.runTipCycle();
    // The wallet is emptied elsewhere. The welcome amount is not sent a second time.
    state.balances.set('0x0000000000000000000000000000000000000001', 100_000n);
    const other = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-OTHER-X' }));
    const second = await thesisBy(author.id, { marketId: other.id });
    await tipRow(second.id, tipper.id, '0.50');
    await onchain.runTipCycle();
    expect((await tipsOf(second.id))[0]).toMatchObject({ status: 'failed' });
    expect(logs.join('\n')).toContain('too little test USDC');
  });
});

describe('runSettlementCycle', () => {
  async function escrowedTip(onchain: ReturnType<typeof setup>['onchain'], thesisId: string, name: string) {
    const tipper = await createGuestUser(db, name);
    await tipRow(thesisId, tipper.id);
    for (let i = 0; i < 3; i += 1) await onchain.runTipCycle();
    return tipper;
  }

  it('reports the outcome and pays a right thesis’s tips to its author', async () => {
    const { onchain, state } = setup();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const thesis = await thesisBy(author.id, { side: 'yes' });
    state.theses.set(thesis.onchainId, { author: '0xauthor', sideYes: true, settled: false });
    await escrowedTip(onchain, thesis.id, 'A');
    await escrowedTip(onchain, thesis.id, 'B');

    // Nothing happens until the market has resolved.
    expect(await onchain.runSettlementCycle()).toEqual({ paid: 0, refunded: 0 });
    await db.update(markets).set({ resolutionSide: 'yes', resolvedAt: new Date() }).where(eq(markets.id, marketId));
    await db.update(theses).set({ status: 'resolved', outcome: 'right' }).where(eq(theses.id, thesis.id));

    expect(await onchain.runSettlementCycle()).toEqual({ paid: 2, refunded: 0 });
    expect(state.markets.get(marketOnchainId(SYMBOL))).toBe('yes');
    expect(state.calls.slice(-2)).toEqual(['report', 'settle']);
    expect((await tipsOf(thesis.id)).map((t) => [t.status, t.settleTx])).toEqual([
      ['paid', '0xsettle2'],
      ['paid', '0xsettle2'],
    ]);
    // A second run finds nothing left to do.
    expect(await onchain.runSettlementCycle()).toEqual({ paid: 0, refunded: 0 });
    expect(state.calls).toHaveLength(2);
  });

  it('returns each tipper’s tip when the thesis was wrong', async () => {
    const { onchain, state } = setup();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const thesis = await thesisBy(author.id, { side: 'yes' });
    state.theses.set(thesis.onchainId, { author: '0xauthor', sideYes: true, settled: false });
    await escrowedTip(onchain, thesis.id, 'A');
    await escrowedTip(onchain, thesis.id, 'B');
    await db.update(markets).set({ resolutionSide: 'no', resolvedAt: new Date() }).where(eq(markets.id, marketId));
    await db.update(theses).set({ status: 'resolved', outcome: 'wrong' }).where(eq(theses.id, thesis.id));

    expect(await onchain.runSettlementCycle()).toEqual({ paid: 0, refunded: 2 });
    expect(state.calls).toEqual(['report', 'refund', 'refund']);
    expect((await tipsOf(thesis.id)).map((t) => t.status)).toEqual(['refunded', 'refunded']);
    expect([...state.held.values()]).toEqual([0n, 0n]);
  });

  it('reports a void market as void and refunds', async () => {
    const { onchain, state } = setup();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const thesis = await thesisBy(author.id);
    state.theses.set(thesis.onchainId, { author: '0xauthor', sideYes: true, settled: false });
    await escrowedTip(onchain, thesis.id, 'A');
    await db.update(markets).set({ resolutionSide: null, status: 'invalid', resolvedAt: new Date() }).where(eq(markets.id, marketId));
    await db.update(theses).set({ status: 'resolved', outcome: 'void' }).where(eq(theses.id, thesis.id));
    expect(await onchain.runSettlementCycle()).toEqual({ paid: 0, refunded: 1 });
    expect(state.markets.get(marketOnchainId(SYMBOL))).toBe('void');
  });

  it('leaves tips in escrow when a chain call fails, and finishes on the next run without paying twice', async () => {
    const { onchain, state } = setup();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const thesis = await thesisBy(author.id);
    state.theses.set(thesis.onchainId, { author: '0xauthor', sideYes: true, settled: false });
    await escrowedTip(onchain, thesis.id, 'A');
    await db.update(markets).set({ resolutionSide: 'yes', resolvedAt: new Date() }).where(eq(markets.id, marketId));
    await db.update(theses).set({ status: 'resolved', outcome: 'right' }).where(eq(theses.id, thesis.id));

    state.failNext = 'settle';
    expect(await onchain.runSettlementCycle()).toEqual({ paid: 0, refunded: 0 });
    expect((await tipsOf(thesis.id))[0]).toMatchObject({ status: 'escrowed' });
    expect(await onchain.runSettlementCycle()).toEqual({ paid: 1, refunded: 0 });
    // The outcome was reported once, and the author paid once.
    expect(state.calls.filter((c) => c === 'report')).toHaveLength(1);
    expect(state.theses.get(thesis.onchainId)!.settled).toBe(true);
  });

  it('marks tips paid when the chain already paid them before a crash', async () => {
    const { onchain, state } = setup();
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const thesis = await thesisBy(author.id);
    await escrowedTip(onchain, thesis.id, 'A');
    state.theses.set(thesis.onchainId, { author: '0xauthor', sideYes: true, settled: true });
    state.markets.set(marketOnchainId(SYMBOL), 'yes');
    await db.update(markets).set({ resolutionSide: 'yes', resolvedAt: new Date() }).where(eq(markets.id, marketId));
    await db.update(theses).set({ status: 'resolved', outcome: 'right' }).where(eq(theses.id, thesis.id));
    expect(await onchain.runSettlementCycle()).toEqual({ paid: 1, refunded: 0 });
    expect((await tipsOf(thesis.id))[0]).toMatchObject({ status: 'paid', settleTx: ALREADY_ONCHAIN });
    expect(state.calls).toEqual([]);
  });
});
