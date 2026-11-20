import {
  createGuestUser,
  ensureAgentAuthor,
  ensureHumanAuthor,
  eq,
  sandboxOrders,
  theses,
  trades,
  upsertMarket,
  type Db,
} from '@thesis/db';
import { createTestDb } from '@thesis/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SandboxRefused,
  createSandboxMirror,
  type SandboxAccount,
  type SandboxFill,
  type SandboxOrder,
} from '../src/sandbox-mirror';

const SYMBOL = 'GEMI-BTC15M2611180500-UP';

/** A sandbox account that answers from memory and remembers every call. */
interface FakeAccount extends SandboxAccount {
  /** Orders the fake exchange accepted. */
  placed: SandboxOrder[];
  /** Every place() call, accepted or not. */
  attempts: number;
  /** Client order ids looked up in the order history. */
  lookups: string[];
  asks: { yes: string | null; no: string | null };
  /** Orders the exchange already holds, by client order id. */
  history: Map<string, SandboxFill>;
  /** What the next place() calls throw, in order, before one succeeds. */
  placeErrors: Error[];
  /** How much of each accepted order fills; all of it unless set. */
  fills: (order: SandboxOrder) => string;
}

function fakeAccount(): FakeAccount {
  const account: FakeAccount = {
    placed: [],
    attempts: 0,
    lookups: [],
    asks: { yes: '0.55', no: '0.47' },
    history: new Map(),
    placeErrors: [],
    fills: (order) => order.quantity,
    async ask(_symbol, side) {
      return account.asks[side];
    },
    async place(order) {
      account.attempts += 1;
      const error = account.placeErrors.shift();
      if (error) throw error;
      account.placed.push(order);
      const filledQuantity = account.fills(order);
      const fill = {
        orderId: `order-${account.placed.length}`,
        filledQuantity,
        avgPrice: Number(filledQuantity) > 0 ? order.price : null,
      };
      account.history.set(order.clientOrderId, fill);
      return fill;
    },
    async findByClientOrderId(id) {
      account.lookups.push(id);
      return account.history.get(id) ?? null;
    },
  };
  return account;
}

let db: Db;
let close: () => Promise<void>;
let marketId: string;
let fakes: Map<string, FakeAccount>;
let mirror: ReturnType<typeof createSandboxMirror>;
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const fake = (agentKey: string) => fakes.get(agentKey)!;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ id: marketId } = await upsertMarket(db, {
    instrumentSymbol: SYMBOL,
    eventTicker: 'BTC15M2611180500',
    contractTicker: 'UP',
    title: 'BTC price today at 12am EST',
    contractLabel: 'Up',
    category: 'Crypto',
    expiryAt: new Date('2026-11-18T05:00:00Z'),
    status: 'active',
    marketState: 'open',
    strike: '64000',
    yesBid: '0.60',
    yesAsk: '0.62',
    lastPrice: null,
    keywords: [],
    quantityIncrement: '0.01',
    quantityMinimum: '0.01',
    priceIncrement: '0.01',
    sourceDetails: null,
  }));
  // Two models have sandbox accounts; the others do not.
  fakes = new Map([
    ['arena-gpt', fakeAccount()],
    ['arena-claude', fakeAccount()],
  ]);
  mirror = createSandboxMirror({ db, accounts: fakes, logger });
});
afterEach(() => close());

let seq = 0;
/** An agent's own filled paper position, as the thesis pipeline leaves it. */
async function authorTrade(agentKey: string, extra: Partial<typeof trades.$inferInsert> = {}) {
  const author = await ensureAgentAuthor(db, { agentKey, displayName: agentKey, strategySummary: 's' });
  seq += 1;
  const [row] = await db
    .insert(trades)
    .values({
      authorId: author.id,
      marketId,
      isAuthorPosition: true,
      side: 'yes',
      quantity: '10',
      price: '0.62',
      costUsd: '6.2000',
      mode: 'paper',
      status: 'filled',
      idempotencyKey: `t-${seq}`,
      createdAt: new Date(),
      ...extra,
    })
    .returning();
  return row!;
}
const row = async (tradeId: string) =>
  (await db.select().from(sandboxOrders).where(eq(sandboxOrders.tradeId, tradeId)))[0];
const allRows = () => db.select().from(sandboxOrders);

describe('createSandboxMirror', () => {
  it("places one IOC order per arena trade from that model's account, at the sandbox ask", async () => {
    const trade = await authorTrade('arena-gpt');
    const no = await authorTrade('arena-claude', { side: 'no', quantity: '16.39' });

    expect(await mirror.runCycle()).toEqual({ placed: 2, recorded: 2, waiting: 0 });
    expect(fake('arena-gpt').placed).toEqual([{ symbol: SYMBOL, side: 'yes', quantity: '10', price: '0.55', clientOrderId: trade.id }]);
    expect(await row(trade.id)).toMatchObject({ status: 'filled', sandboxPrice: '0.5500' });
    expect(await row(trade.id)).toMatchObject({
      agentKey: 'arena-gpt',
      clientOrderId: trade.id,
      orderId: 'order-1',
      filledQuantity: '10.0000',
      errorCode: null,
    });
    // A NO position is bought at the sandbox's NO ask, from its own model's account.
    expect(fake('arena-claude').placed).toEqual([
      { symbol: SYMBOL, side: 'no', quantity: '16.39', price: '0.47', clientOrderId: no.id },
    ]);

    // Once recorded, a trade is never placed again.
    expect(await mirror.runCycle()).toEqual({ placed: 0, recorded: 0, waiting: 0 });
    expect(fake('arena-gpt').attempts).toBe(1);
  });

  it('records what an IOC order actually filled: part of it, or none', async () => {
    fake('arena-gpt').fills = () => '4';
    fake('arena-claude').fills = () => '0';
    const part = await authorTrade('arena-gpt');
    const none = await authorTrade('arena-claude');

    await mirror.runCycle();
    expect(await row(part.id)).toMatchObject({ status: 'partial', filledQuantity: '4.0000', sandboxPrice: '0.5500' });
    expect(await row(none.id)).toMatchObject({ status: 'unfilled', orderId: 'order-1', filledQuantity: '0.0000', sandboxPrice: null });
  });

  it('a pending order found in history is recorded, not placed again', async () => {
    const trade = await authorTrade('arena-gpt');
    // A worker stopped after the sandbox took the order and before it wrote the result.
    await db.insert(sandboxOrders).values({
      tradeId: trade.id,
      agentKey: 'arena-gpt',
      clientOrderId: trade.id,
      status: 'pending',
      createdAt: minutesAgo(5),
      updatedAt: minutesAgo(5),
    });
    fake('arena-gpt').history.set(trade.id, { orderId: 'earlier', filledQuantity: '10', avgPrice: '0.56' });

    expect(await mirror.runCycle()).toEqual({ placed: 0, recorded: 1, waiting: 0 });
    expect(fake('arena-gpt').placed).toEqual([]);
    expect(await row(trade.id)).toMatchObject({ status: 'filled' });
    expect(await row(trade.id)).toMatchObject({ orderId: 'earlier', sandboxPrice: '0.5600', filledQuantity: '10.0000' });
  });

  it('leaves a pending order alone while another worker may still be placing it', async () => {
    const trade = await authorTrade('arena-gpt');
    // Claimed a moment ago, with no error recorded: its order may be on its way.
    await db.insert(sandboxOrders).values({ tradeId: trade.id, agentKey: 'arena-gpt', clientOrderId: trade.id, status: 'pending' });

    expect(await mirror.runCycle()).toEqual({ placed: 0, recorded: 0, waiting: 1 });
    expect(fake('arena-gpt').lookups).toEqual([]);
    expect(fake('arena-gpt').attempts).toBe(0);

    // Long enough later, that attempt is over: look it up, and place it only if it never arrived.
    await db.update(sandboxOrders).set({ updatedAt: minutesAgo(5) }).where(eq(sandboxOrders.tradeId, trade.id));
    expect(await mirror.runCycle()).toEqual({ placed: 1, recorded: 1, waiting: 0 });
    expect(fake('arena-gpt').lookups).toEqual([trade.id]);
    expect(await row(trade.id)).toMatchObject({ status: 'filled' });
  });

  it("leaves people's trades and copies alone", async () => {
    // A person's own position on their thesis.
    const person = await createGuestUser(db, 'Sam');
    const human = await ensureHumanAuthor(db, person);
    await db.insert(trades).values({
      userId: person.id,
      authorId: human.id,
      marketId,
      isAuthorPosition: true,
      side: 'yes',
      quantity: '10',
      price: '0.62',
      costUsd: '6.2000',
      mode: 'paper',
      status: 'filled',
      idempotencyKey: 'human-own',
    });
    // A person copying an arena model's thesis.
    const gpt = await ensureAgentAuthor(db, { agentKey: 'arena-gpt', displayName: 'GPT-5', strategySummary: 's' });
    const [thesis] = await db
      .insert(theses)
      .values({ onchainId: '0xmirror', authorId: gpt.id, marketId, side: 'yes', probabilityYes: '0.7', headline: 'h', body: 'b', status: 'published' })
      .returning();
    const copier = await createGuestUser(db, 'Copier');
    await db.insert(trades).values({
      userId: copier.id,
      marketId,
      thesisId: thesis!.id,
      isAuthorPosition: false,
      side: 'yes',
      quantity: '10',
      price: '0.62',
      costUsd: '6.2000',
      mode: 'paper',
      status: 'filled',
      idempotencyKey: 'copy',
    });
    // An agent outside the arena.
    await authorTrade('news');

    expect(await mirror.runCycle()).toEqual({ placed: 0, recorded: 0, waiting: 0 });
    expect(await allRows()).toEqual([]);
    expect(fake('arena-gpt').attempts).toBe(0);
  });

  it('mirrors only trades made after the mirror first ran, once their paper fill is done', async () => {
    const before = await authorTrade('arena-gpt', { createdAt: minutesAgo(1) });
    const late = createSandboxMirror({ db, accounts: fakes, logger });
    const auditing = await authorTrade('arena-claude', { status: 'pending' });
    const rejected = await authorTrade('arena-claude', { status: 'rejected' });

    expect(await late.runCycle()).toEqual({ placed: 0, recorded: 0, waiting: 0 });

    await db.update(trades).set({ status: 'partial' }).where(eq(trades.id, auditing.id));
    expect(await late.runCycle()).toEqual({ placed: 1, recorded: 1, waiting: 0 });
    expect((await allRows()).map((r) => r.tradeId)).toEqual([auditing.id]);

    // After a restart, the first mirrored order marks where mirroring began.
    const restarted = createSandboxMirror({ db, accounts: fakes, logger });
    const after = await authorTrade('arena-gpt');
    await restarted.runCycle();
    expect((await allRows()).map((r) => r.tradeId).sort()).toEqual([auditing.id, after.id].sort());
    expect(await row(before.id)).toBeUndefined();
    expect(await row(rejected.id)).toBeUndefined();
  });

  it('records unfilled when the sandbox has no seller', async () => {
    fake('arena-gpt').asks.yes = null;
    const trade = await authorTrade('arena-gpt');

    expect(await mirror.runCycle()).toEqual({ placed: 0, recorded: 1, waiting: 0 });
    expect(await row(trade.id)).toMatchObject({ status: 'unfilled' });
    expect(await row(trade.id)).toMatchObject({ orderId: null, sandboxPrice: null });
    expect(fake('arena-gpt').placed).toEqual([]);
  });

  it('records failed without retrying when the model has no sandbox account', async () => {
    const trade = await authorTrade('arena-grok');

    expect(await mirror.runCycle()).toEqual({ placed: 0, recorded: 1, waiting: 0 });
    expect(await mirror.runCycle()).toEqual({ placed: 0, recorded: 0, waiting: 0 });
    expect(await row(trade.id)).toMatchObject({ status: 'failed', errorCode: 'no_sandbox_account' });
    expect(await allRows()).toHaveLength(1);
  });

  it("records failed with the sandbox's reason when it refuses an order, and does not retry", async () => {
    fake('arena-gpt').placeErrors.push(new SandboxRefused('insufficient_funds'));
    const trade = await authorTrade('arena-gpt');

    expect(await mirror.runCycle()).toEqual({ placed: 0, recorded: 1, waiting: 0 });
    await mirror.runCycle();
    expect(await row(trade.id)).toMatchObject({ status: 'failed', errorCode: 'insufficient_funds', orderId: null });
    expect(fake('arena-gpt').attempts).toBe(1);
  });

  it('agents that share a key place their orders through one account, one at a time', async () => {
    // One sandbox account behind two models, each of whose calls takes a moment.
    const shared = fakeAccount();
    let inFlight = 0;
    let mostAtOnce = 0;
    const slow =
      <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        inFlight += 1;
        mostAtOnce = Math.max(mostAtOnce, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await call(...args);
        } finally {
          inFlight -= 1;
        }
      };
    const account: SandboxAccount = {
      ask: slow(shared.ask),
      place: slow(shared.place),
      findByClientOrderId: slow(shared.findByClientOrderId),
    };
    const sharing = createSandboxMirror({
      db,
      accounts: new Map([
        ['arena-gpt', account],
        ['arena-deepseek', account],
      ]),
      logger,
    });
    const gpt = await authorTrade('arena-gpt');
    const deepseek = await authorTrade('arena-deepseek', { side: 'no' });

    expect(await sharing.runCycle()).toEqual({ placed: 2, recorded: 2, waiting: 0 });
    expect(shared.placed.map((o) => [o.clientOrderId, o.side])).toEqual([
      [gpt.id, 'yes'],
      [deepseek.id, 'no'],
    ]);
    expect(mostAtOnce).toBe(1);
    expect(await row(deepseek.id)).toMatchObject({ status: 'filled', agentKey: 'arena-deepseek' });
  });

  it('keeps a trade pending through a network error and retries it', async () => {
    fake('arena-gpt').placeErrors.push(new TypeError('fetch failed'));
    const trade = await authorTrade('arena-gpt');

    expect(await mirror.runCycle()).toEqual({ placed: 0, recorded: 0, waiting: 1 });
    expect(await row(trade.id)).toMatchObject({ status: 'pending', errorCode: 'network_error' });

    // The next cycle looks the order up first: it never arrived, so it is placed now.
    expect(await mirror.runCycle()).toEqual({ placed: 1, recorded: 1, waiting: 0 });
    expect(fake('arena-gpt').lookups).toEqual([trade.id]);
    expect(await row(trade.id)).toMatchObject({ status: 'filled' });
    expect(await row(trade.id)).toMatchObject({ errorCode: null });
    expect(fake('arena-gpt').placed).toHaveLength(1);
  });
});
