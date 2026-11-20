/**
 * The sandbox mirror: each arena model's own paper trade is also placed as a real
 * immediate-or-cancel order from its Gemini sandbox account (models may share one), as proof
 * that the model holds an exchange account. The sandbox price is recorded beside the paper price
 * and never used for the score: sandbox books are made by bots and do not track production.
 *
 * A trade is claimed by writing its `pending` row before the sandbox is called, so it is placed at
 * most once. A call that gets no answer leaves the row pending; the next attempt first looks the
 * order up by its client order id (the trade id) and places it only if the sandbox never got it.
 *
 * Several models may share one sandbox account (one key). Every sandbox call here is awaited
 * before the next is made, never in parallel, so a shared key's time-based nonces cannot collide.
 *
 * This file knows the sandbox only through `SandboxAccount`; sandbox-account.ts is the SDK side.
 */
import {
  and,
  asc,
  authors,
  eq,
  gte,
  inArray,
  lt,
  markets,
  or,
  sandboxOrders,
  sql,
  trades,
  type Db,
  type SandboxOrderStatus,
} from '@thesis/db';
import type { Logger } from './recorder';

export type SandboxSide = 'yes' | 'no';

export interface SandboxOrder {
  symbol: string;
  side: SandboxSide;
  quantity: string;
  price: string;
  clientOrderId: string;
}

/** An order the sandbox holds: how much of it filled, and at what average price. */
export interface SandboxFill {
  orderId: string;
  filledQuantity: string;
  avgPrice: string | null;
}

/** One model's sandbox account. */
export interface SandboxAccount {
  /** The sandbox's best price to buy `side` of the contract, or null when nobody is selling. */
  ask(symbol: string, side: SandboxSide): Promise<string | null>;
  /** Buys `side` at `price` or better, immediate-or-cancel. */
  place(o: SandboxOrder): Promise<SandboxFill>;
  /** The account's order with this client order id, or null when the sandbox has none. */
  findByClientOrderId(id: string): Promise<SandboxFill | null>;
}

/**
 * The sandbox answered and said no (a bad order, no funds, terms not accepted, a rejected key).
 * Asking again would get the same answer, so the trade is recorded as failed with `code`. Any
 * other error may mean the request never arrived, and the trade stays pending.
 */
export class SandboxRefused extends Error {
  constructor(readonly code: string) {
    super(`the sandbox refused the request (${code})`);
    this.name = 'SandboxRefused';
  }
}

export interface SandboxMirrorDeps {
  db: Db;
  /** By agent key. A model without one has its trades recorded as failed. */
  accounts: Map<string, SandboxAccount>;
  logger: Logger;
}

export interface SandboxMirrorSummary {
  /** Orders the sandbox accepted this cycle. */
  placed: number;
  /** Trades given a final status this cycle (filled, partial, unfilled or failed). */
  recorded: number;
  /** Trades still pending after the cycle. */
  waiting: number;
}

/**
 * How long after its last attempt began a pending row with no error recorded is taken up again.
 * Longer than one attempt can take (the SDK gives a request 30 seconds), so a row that another
 * worker is still placing, for example during a deploy, is left to it.
 */
const ATTEMPT_MS = 2 * 60_000;
const NETWORK_ERROR = 'network_error';
/** With the error's class: the SDK's own message for a refused request is only "HTTP 400". */
const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** The trade a mirror row is for. */
interface Mirrored {
  tradeId: string;
  agentKey: string;
  symbol: string;
  side: SandboxSide;
  /** As stored: four decimals. */
  quantity: string;
}

type Result = {
  status: Exclude<SandboxOrderStatus, 'pending'>;
  orderId?: string | null;
  sandboxPrice?: string | null;
  filledQuantity?: string | null;
  errorCode?: string | null;
};

/** `16.3900` as the sandbox wants a quantity: `16.39`. */
const plainDecimal = (value: string) => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);

/** What an order the sandbox holds comes to. `limit` is the price sent, when this worker sent it. */
function resultOf(fill: SandboxFill, quantity: string, limit: string | null): Result {
  const filled = Number(fill.filledQuantity);
  return {
    status: filled <= 0 ? 'unfilled' : filled >= Number(quantity) ? 'filled' : 'partial',
    orderId: fill.orderId || null,
    filledQuantity: fill.filledQuantity,
    // An IOC buy fills at the limit or better; the average is what the sandbox reports.
    sandboxPrice: filled > 0 ? (fill.avgPrice ?? limit) : null,
    errorCode: null,
  };
}

export function createSandboxMirror({ db, accounts, logger }: SandboxMirrorDeps) {
  /** "Created after the mirror first ran", for a mirror with no rows yet. */
  const startedAt = new Date();

  /**
   * Trades made before this are never mirrored. The oldest row's creation marks when mirroring
   * began; this process's start counts too, so a trade made after the first start but filled
   * after the first row (another model's audit took longer) is still mirrored.
   */
  async function cutoff(): Promise<Date> {
    const [oldest] = await db
      .select({ createdAt: sandboxOrders.createdAt })
      .from(sandboxOrders)
      .orderBy(asc(sandboxOrders.createdAt))
      .limit(1);
    return oldest && oldest.createdAt < startedAt ? oldest.createdAt : startedAt;
  }

  /** Writes a final status, unless another worker already did. */
  async function finish(row: Mirrored, result: Result): Promise<void> {
    await db
      .update(sandboxOrders)
      .set({ ...result, updatedAt: new Date() })
      .where(and(eq(sandboxOrders.tradeId, row.tradeId), eq(sandboxOrders.status, 'pending')));
    const detail =
      result.status === 'failed'
        ? result.errorCode
        : result.sandboxPrice
          ? `${result.filledQuantity} at ${result.sandboxPrice}`
          : 'nothing filled';
    logger.info(`sandbox order for ${row.agentKey} trade ${row.tradeId}: ${result.status} (${detail})`);
  }

  /**
   * One attempt at a claimed trade. `lookFirst` when an earlier attempt may have reached the
   * sandbox. Returns whether an order was placed and whether the trade got a final status.
   */
  async function attempt(row: Mirrored, lookFirst: boolean): Promise<{ placed: boolean; recorded: boolean }> {
    const account = accounts.get(row.agentKey);
    if (!account) {
      await finish(row, { status: 'failed', errorCode: 'no_sandbox_account' });
      return { placed: false, recorded: true };
    }
    let placed = false;
    try {
      if (lookFirst) {
        const found = await account.findByClientOrderId(row.tradeId);
        if (found) {
          await finish(row, resultOf(found, row.quantity, null));
          return { placed, recorded: true };
        }
      }
      // The sandbox's own price at order time, crossing its book.
      const price = await account.ask(row.symbol, row.side);
      if (price === null) {
        await finish(row, { status: 'unfilled' });
        return { placed, recorded: true };
      }
      const fill = await account.place({
        symbol: row.symbol,
        side: row.side,
        quantity: plainDecimal(row.quantity),
        price,
        clientOrderId: row.tradeId,
      });
      placed = true;
      await finish(row, resultOf(fill, row.quantity, price));
      return { placed, recorded: true };
    } catch (error) {
      if (error instanceof SandboxRefused) {
        await finish(row, { status: 'failed', errorCode: error.code });
        return { placed, recorded: true };
      }
      // No answer, or one that may change. The row stays pending and marked, so the next cycle
      // looks the order up before it places it.
      await db
        .update(sandboxOrders)
        .set({ errorCode: NETWORK_ERROR, updatedAt: new Date() })
        .where(and(eq(sandboxOrders.tradeId, row.tradeId), eq(sandboxOrders.status, 'pending')));
      logger.warn(`sandbox order for ${row.agentKey} trade ${row.tradeId} stays pending: ${errorText(error)}`);
      return { placed, recorded: false };
    }
  }

  /** The trades behind these mirror rows, with what an order needs. */
  async function tradesFor(tradeIds: string[]): Promise<Mirrored[]> {
    if (tradeIds.length === 0) return [];
    const rows = await db
      .select({
        tradeId: trades.id,
        agentKey: sandboxOrders.agentKey,
        symbol: markets.instrumentSymbol,
        side: trades.side,
        quantity: trades.quantity,
      })
      .from(sandboxOrders)
      .innerJoin(trades, eq(trades.id, sandboxOrders.tradeId))
      .innerJoin(markets, eq(markets.id, trades.marketId))
      .where(inArray(sandboxOrders.tradeId, tradeIds));
    return rows;
  }

  return {
    async runCycle(): Promise<SandboxMirrorSummary> {
      const summary: SandboxMirrorSummary = { placed: 0, recorded: 0, waiting: 0 };
      const count = ({ placed, recorded }: { placed: boolean; recorded: boolean }) => {
        if (placed) summary.placed += 1;
        if (recorded) summary.recorded += 1;
      };

      // Pending rows an earlier attempt left: after a network error at once, otherwise once that
      // attempt is surely over. Taking a row moves its clock, so no other worker takes it too.
      const taken = await db
        .update(sandboxOrders)
        .set({ errorCode: null, updatedAt: new Date() })
        .where(
          and(
            eq(sandboxOrders.status, 'pending'),
            or(eq(sandboxOrders.errorCode, NETWORK_ERROR), lt(sandboxOrders.updatedAt, new Date(Date.now() - ATTEMPT_MS))),
          ),
        )
        .returning({ tradeId: sandboxOrders.tradeId });
      for (const row of await tradesFor(taken.map((t) => t.tradeId))) count(await attempt(row, true));

      // New trades: arena models' own positions, filled on paper since mirroring began.
      const fresh = await db
        .select({
          tradeId: trades.id,
          agentKey: authors.agentKey,
          symbol: markets.instrumentSymbol,
          side: trades.side,
          quantity: trades.quantity,
        })
        .from(trades)
        .innerJoin(authors, eq(authors.id, trades.authorId))
        .innerJoin(markets, eq(markets.id, trades.marketId))
        .where(
          and(
            eq(trades.isAuthorPosition, true),
            inArray(trades.status, ['filled', 'partial']),
            sql`${authors.agentKey} like 'arena-%'`,
            gte(trades.createdAt, await cutoff()),
            sql`not exists (select 1 from ${sandboxOrders} where ${sandboxOrders.tradeId} = ${trades.id})`,
          ),
        )
        .orderBy(asc(trades.createdAt));
      for (const trade of fresh) {
        const row = { ...trade, agentKey: trade.agentKey ?? '' };
        // The claim: whoever inserts the row places the order.
        const [claimed] = await db
          .insert(sandboxOrders)
          .values({ tradeId: row.tradeId, agentKey: row.agentKey, clientOrderId: row.tradeId, status: 'pending' })
          .onConflictDoNothing()
          .returning({ tradeId: sandboxOrders.tradeId });
        if (claimed) count(await attempt(row, false));
      }

      const [pending] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(sandboxOrders)
        .where(eq(sandboxOrders.status, 'pending'));
      summary.waiting = pending?.count ?? 0;
      return summary;
    },
  };
}
