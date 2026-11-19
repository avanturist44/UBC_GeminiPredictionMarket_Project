import { createHash } from 'node:crypto';
import { marketOnchainId, toUnits } from '@thesis/core';
import {
  and,
  asc,
  authors,
  eq,
  markets,
  sql,
  theses,
  tips,
  users,
  type AuthorRow,
  type Db,
  type MarketRecord,
  type ThesisRow,
} from '@thesis/db';
import type { Address, Hex } from 'viem';
import type { EscrowChain } from './chain';
import { CircleRefused, type CircleWallets } from './circle';
import type { Logger } from './recorder';

/**
 * Worker job 4 and the on-chain half of job 5: everything that touches the TipEscrow
 * contract or a Circle wallet.
 *
 * - Registrar: records a thesis on-chain before it is published, so a tip can never arrive
 *   for a thesis the contract does not know.
 * - Tips: a copy trade leaves a `pending` tip row. This job gives the tipper a wallet if they
 *   have none (a smart contract account, funded once with a little test USDC and approved
 *   for the escrow), sends the tip from it, and marks the row `escrowed` or `failed`.
 * - Settlement: once a market has resolved, reports the outcome to the contract, pays the
 *   tips of right theses to their authors, and returns the tips of wrong or void ones.
 *
 * Every step checks state before it acts and can be repeated: Circle calls carry a fixed
 * idempotency key, and chain calls that are already done send nothing. A crash at any point
 * is picked up on the next cycle without paying or refunding twice. The contract itself is
 * the final guard: tips can only go to the registered author or back to the tipper.
 */

export interface OnchainDeps {
  db: Db;
  chain: EscrowChain;
  circle: CircleWallets;
  logger: Logger;
  /** Test USDC sent to a new wallet, once. */
  welcomeUsdc?: string;
  now?: () => Date;
}

/** USDC the escrow may pull from a user's wallet: 20, as 6-decimal units. */
const APPROVAL_UNITS = '20000000';
/** Stored when a call was found already done on-chain and its transaction hash is not known. */
export const ALREADY_ONCHAIN = 'already-on-chain';
const YEAR_MS = 365 * 86_400_000;
/**
 * How long a tip that has not reached Circle yet is retried through outages before it is
 * given up. Short enough that a user is told within the visit, long enough to ride out a
 * busy RPC node or a Circle hiccup.
 */
export const TIP_RETRY_WINDOW_MS = 10 * 60_000;

/** A tip that cannot be sent, whatever is retried: there is no point trying again. */
class TipRefused extends Error {}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A stable UUID from a label, so a retried Circle call is the same call and runs once. */
export function stableKey(label: string): string {
  const h = createHash('sha256').update(label).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 0.25 USDC becomes 250000. */
const usdcUnits = (amount: string) => (toUnits(amount) * 100n).toString();

export interface Onchain {
  /** Records the thesis on-chain. Returns the transaction hash, or a marker if it was already there. */
  register(row: { thesis: ThesisRow; author: AuthorRow; market: MarketRecord }): Promise<string>;
  /** Moves pending tips along. Returns how many reached escrow and how many failed. */
  runTipCycle(): Promise<{ escrowed: number; failed: number; waiting: number }>;
  /** Pays or refunds the tips of resolved theses. */
  runSettlementCycle(): Promise<{ paid: number; refunded: number }>;
}

export function createOnchain(deps: OnchainDeps): Onchain {
  const { db, chain, circle, logger } = deps;
  const welcome = deps.welcomeUsdc ?? '2';
  const now = deps.now ?? (() => new Date());
  /** Circle transactions sent for a wallet and not yet seen to finish. */
  const inFlight = new Map<string, string>();

  /** True once a Circle transaction has finished. Throws if it failed. */
  async function finished(slot: string, send: () => Promise<string>): Promise<boolean> {
    let id = inFlight.get(slot);
    if (!id) {
      id = await send();
      inFlight.set(slot, id);
    }
    const tx = await circle.transaction(id);
    if (tx.state === 'pending') return false;
    inFlight.delete(slot);
    if (tx.state === 'failed') throw new TipRefused(tx.error ?? 'the Circle transaction failed');
    return true;
  }

  /** The author's payout address: a person's own wallet, or one made for the agent. */
  async function authorAddress(author: AuthorRow): Promise<Address> {
    if (author.walletAddress) return author.walletAddress as Address;
    let address: string;
    if (author.userId) {
      const [user] = await db.select().from(users).where(eq(users.id, author.userId));
      if (user?.walletAddress) address = user.walletAddress;
      else {
        const wallet = await circle.createWallet(author.userId);
        await db.update(users).set({ circleWalletId: wallet.walletId, walletAddress: wallet.address }).where(eq(users.id, author.userId));
        address = wallet.address;
      }
    } else {
      address = (await circle.createWallet(author.id)).address;
    }
    await db.update(authors).set({ walletAddress: address }).where(eq(authors.id, author.id));
    return address as Address;
  }

  /**
   * Gets a tipper's wallet ready to tip `units`. Returns the wallet when it is ready, null
   * while a step is still in progress, and throws when it cannot be made ready.
   */
  async function tipperWallet(userId: string, units: bigint): Promise<{ walletId: string; address: Address } | null> {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new TipRefused('the tipper no longer exists');
    let walletId = user.circleWalletId;
    let address = user.walletAddress;
    if (!walletId || !address) {
      const wallet = await circle.createWallet(userId);
      await db.update(users).set({ circleWalletId: wallet.walletId, walletAddress: wallet.address }).where(eq(users.id, userId));
      ({ walletId, address } = wallet);
    }
    const owner = address as Address;

    if ((await chain.usdcBalance(owner)) < units) {
      // The welcome amount is sent once per wallet: the key is the same on every retry.
      const sent = await finished(`fund:${walletId}`, () => circle.fundFromTreasury(owner, welcome, stableKey(`fund:${walletId}`)));
      if (!sent) return null;
      if ((await chain.usdcBalance(owner)) < units) throw new TipRefused('the wallet has too little test USDC left for this tip');
    }
    if ((await chain.usdcAllowance(owner)) < units) {
      const approved = await finished(`approve:${walletId}`, () =>
        circle.execute({
          walletId: walletId!,
          contractAddress: chain.usdcAddress,
          abiFunctionSignature: 'approve(address,uint256)',
          abiParameters: [chain.escrowAddress, APPROVAL_UNITS],
          // An approval is repeated only when the allowance has run out, so its key is
          // fixed within a ten-minute window and new after it.
          idempotencyKey: stableKey(`approve:${walletId}:${Math.floor(now().getTime() / 600_000)}`),
        }),
      );
      if (!approved) return null;
    }
    return { walletId, address: owner };
  }

  async function failTip(tipId: string, reason: string): Promise<void> {
    await db.update(tips).set({ status: 'failed' }).where(and(eq(tips.id, tipId), eq(tips.status, 'pending')));
    logger.warn(`tips: tip ${tipId} failed: ${reason}`);
  }

  /**
   * A tip that has not reached Circle hit an error. Fails it if the error is final or the
   * tip has run out of time; otherwise leaves it pending for the next cycle. Returns
   * whether it was failed.
   */
  async function handleTipError(tip: { id: string; userId: string; createdAt: Date }, onchainId: string, error: unknown): Promise<boolean> {
    const reason = errorText(error);
    if (error instanceof TipRefused || error instanceof CircleRefused) {
      await failTip(tip.id, reason);
      return true;
    }
    if (now().getTime() - tip.createdAt.getTime() < TIP_RETRY_WINDOW_MS) {
      logger.warn(`tips: tip ${tip.id} waits, will retry: ${reason}`);
      return false;
    }
    // Out of time. One case must not be given up: Circle may have taken the tip even though
    // its answer was lost, so look at the escrow before saying it failed.
    const [user] = await db.select({ address: users.walletAddress }).from(users).where(eq(users.id, tip.userId));
    if (user?.address) {
      let held: bigint;
      try {
        held = await chain.tipOf(onchainId as Hex, user.address as Address);
      } catch {
        logger.warn(`tips: tip ${tip.id} is out of time, but the escrow cannot be read to confirm; will retry: ${reason}`);
        return false;
      }
      if (held > 0n) {
        logger.error(
          `tips: tip ${tip.id} could not be confirmed, but the escrow already holds a tip from ${user.address} ` +
            `on this thesis. Left pending for a person to check: ${reason}`,
        );
        return false;
      }
    }
    await failTip(tip.id, `gave up after ${TIP_RETRY_WINDOW_MS / 60_000} minutes of retrying: ${reason}`);
    return true;
  }

  return {
    async register({ thesis, author, market }) {
      const hash = await chain.registerThesis({
        id: thesis.onchainId as Hex,
        author: await authorAddress(author),
        marketId: marketOnchainId(market.instrumentSymbol) as Hex,
        sideYes: thesis.side === 'yes',
        contentHash: (thesis.contentHash ?? `0x${'0'.repeat(64)}`) as Hex,
        expiry: market.expiryAt ?? new Date(now().getTime() + YEAR_MS),
      });
      return hash ?? ALREADY_ONCHAIN;
    },

    async runTipCycle() {
      const summary = { escrowed: 0, failed: 0, waiting: 0 };
      const pending = await db
        .select({ tip: tips, thesis: theses })
        .from(tips)
        .innerJoin(theses, eq(theses.id, tips.thesisId))
        .where(eq(tips.status, 'pending'))
        .orderBy(asc(tips.createdAt))
        .limit(10);

      for (const { tip, thesis } of pending) {
        if (tip.circleTxId) {
          // The tip is with Circle, so the money may already be in escrow. Only Circle's own
          // final answer decides it; failing to ask is never a reason to fail the tip.
          try {
            const tx = await circle.transaction(tip.circleTxId);
            if (tx.state === 'complete') {
              await db.update(tips).set({ status: 'escrowed', depositTx: tx.txHash }).where(and(eq(tips.id, tip.id), eq(tips.status, 'pending')));
              summary.escrowed += 1;
            } else if (tx.state === 'failed') {
              await failTip(tip.id, tx.error ?? 'the tip transaction failed');
              summary.failed += 1;
            } else summary.waiting += 1;
          } catch (error) {
            logger.warn(`tips: tip ${tip.id} is with Circle; its state could not be read, will retry: ${errorText(error)}`);
            summary.waiting += 1;
          }
          continue;
        }
        try {
          if (!thesis.registerTx) {
            await failTip(tip.id, 'the thesis is not registered on-chain');
            summary.failed += 1;
            continue;
          }
          const units = BigInt(usdcUnits(tip.amountUsdc));
          const wallet = await tipperWallet(tip.userId, units);
          if (!wallet) {
            summary.waiting += 1;
            continue;
          }
          const circleTxId = await circle.execute({
            walletId: wallet.walletId,
            contractAddress: chain.escrowAddress,
            abiFunctionSignature: 'tip(bytes32,uint256)',
            abiParameters: [thesis.onchainId, units.toString()],
            // One tip row is one tip, however often this is retried.
            idempotencyKey: stableKey(`tip:${tip.id}`),
          });
          await db.update(tips).set({ circleTxId }).where(eq(tips.id, tip.id));
          summary.waiting += 1;
        } catch (error) {
          if (await handleTipError(tip, thesis.onchainId, error)) summary.failed += 1;
          else summary.waiting += 1;
        }
      }
      return summary;
    },

    async runSettlementCycle() {
      const summary = { paid: 0, refunded: 0 };
      // Resolved, registered theses that still have tips sitting in escrow.
      const due = await db
        .selectDistinct({ thesis: theses, market: markets })
        .from(tips)
        .innerJoin(theses, eq(theses.id, tips.thesisId))
        .innerJoin(markets, eq(markets.id, theses.marketId))
        .where(and(eq(tips.status, 'escrowed'), eq(theses.status, 'resolved'), sql`${theses.registerTx} is not null`))
        .limit(5);

      for (const { thesis, market } of due) {
        try {
          if (!thesis.outcome) continue;
          const voided = thesis.outcome === 'void' || market.resolutionSide === null;
          const marketId = marketOnchainId(market.instrumentSymbol) as Hex;
          const id = thesis.onchainId as Hex;
          // The contract works out who was right from the side stored at registration.
          await chain.reportOutcome(marketId, voided ? 'void' : market.resolutionSide!);
          const held = and(eq(tips.thesisId, thesis.id), eq(tips.status, 'escrowed'));

          if (thesis.outcome === 'right' && !voided) {
            const hash = await chain.settle(id);
            const rows = await db.update(tips).set({ status: 'paid', settleTx: hash ?? ALREADY_ONCHAIN }).where(held).returning({ id: tips.id });
            summary.paid += rows.length;
            continue;
          }
          const tippers = await db
            .selectDistinct({ userId: tips.userId, address: users.walletAddress })
            .from(tips)
            .innerJoin(users, eq(users.id, tips.userId))
            .where(held);
          for (const tipper of tippers) {
            if (!tipper.address) continue;
            const hash = await chain.refund(id, tipper.address as Address);
            const rows = await db
              .update(tips)
              .set({ status: 'refunded', settleTx: hash ?? ALREADY_ONCHAIN })
              .where(and(held, eq(tips.userId, tipper.userId)))
              .returning({ id: tips.id });
            summary.refunded += rows.length;
          }
        } catch (error) {
          // Retried next cycle. The tips stay `escrowed` until the chain call is confirmed.
          logger.error(`settlement: thesis ${thesis.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return summary;
    },
  };
}
