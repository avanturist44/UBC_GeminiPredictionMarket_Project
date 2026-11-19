import { encodeFunctionData, getAddress, type Hex } from 'viem';
import { and, asc, audits, authors, chainActions, eq, gt, inArray, isNull, lt, markets, sql, theses,
  thesisJobs, thesisRegistrations, tips, trades, users, walletAccounts, type Db } from '@thesis/db';
import type { GeminiPublicClient } from '@thesis/core';
import { decimal, units } from '../money';
import { hashContent } from '../publication';
import { escrowAbi, usdcUnits } from './abi';
import { advanceAction, enqueueAction } from './actions';
import { advanceWallet, ensureWallet } from './wallets';
import type { ChainGateway } from './gateway';
const hex = (value: string) => value as Hex;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function enqueueRegistrations(db: Db, gateway: ChainGateway, now = Date.now()) {
  const rows = await db.select({ thesis: theses, author: authors, market: markets }).from(theses)
    .innerJoin(authors, eq(authors.id, theses.authorId)).innerJoin(markets, eq(markets.id, theses.marketId))
    .where(and(inArray(theses.status, ['published', 'auditing']), isNull(theses.registerTx),
      eq(markets.status, 'active'), eq(markets.marketState, 'open'), gt(markets.expiryAt, new Date(now + 120_000))))
    .orderBy(asc(markets.expiryAt)).limit(10);
  for (const row of rows) {
    const checked = await db.select().from(audits).where(eq(audits.thesisId, row.thesis.id)).orderBy(sql`${audits.createdAt} desc`).limit(1);
    if (!checked.length || checked[0]!.verdict === 'blocked' || !/^0x[a-f0-9]{64}$/i.test(row.thesis.contentHash ?? '')) continue;
    if (row.thesis.status === 'auditing' && row.author.kind === 'human') {
      const [job] = await db.select().from(thesisJobs).where(eq(thesisJobs.thesisId, row.thesis.id));
      if (job?.status !== 'registering') continue;
    }
    const wallet = await ensureWallet(db, row.author.userId ? { userId: row.author.userId } : { authorId: row.author.id }, now);
    if (wallet.status !== 'ready' || !wallet.address) continue;
    await db.transaction(async tx => {
      const [thesis] = await tx.select().from(theses).where(eq(theses.id, row.thesis.id)).for('update');
      if (!thesis || thesis.registerTx || !['published', 'auditing'].includes(thesis.status)) return;
      const key = `register:${gateway.escrowAddress}:${thesis.id}`;
      const marketHash = hashContent(row.market.id);
      const action = await enqueueAction(tx, { key, kind: 'register', walletId: gateway.treasuryWalletId,
        contractAddress: gateway.escrowAddress, callData: encodeFunctionData({ abi: escrowAbi, functionName: 'registerThesis',
          args: [hex(thesis.onchainId), getAddress(wallet.address!), hex(marketHash), thesis.side === 'yes', hex(thesis.contentHash!), BigInt(Math.floor(row.market.expiryAt!.getTime() / 1000))] }) });
      await tx.insert(thesisRegistrations).values({ thesisId: thesis.id, escrowAddress: gateway.escrowAddress,
        authorAddress: wallet.address!, marketHash, contentHash: thesis.contentHash!, expiryAt: row.market.expiryAt!, actionKey: action.key }).onConflictDoNothing();
    });
  }
}

export async function confirmRegistrations(db: Db, gateway: ChainGateway) {
  const rows = await db.select({ registration: thesisRegistrations, action: chainActions, thesis: theses, author: authors }).from(thesisRegistrations)
    .innerJoin(chainActions, eq(chainActions.key, thesisRegistrations.actionKey)).innerJoin(theses, eq(theses.id, thesisRegistrations.thesisId))
    .innerJoin(authors, eq(authors.id, theses.authorId)).where(isNull(thesisRegistrations.confirmedAt)).limit(30);
  for (const { registration, action, thesis, author } of rows) {
    if (!same(registration.escrowAddress, gateway.escrowAddress)) continue;
    if (action.status === 'failed') {
      await db.transaction(async tx => {
        const [job] = await tx.select().from(thesisJobs).where(eq(thesisJobs.thesisId, thesis.id)).for('update');
        if (job?.status === 'registering') {
          await tx.update(thesisJobs).set({ status: 'failed', errorCode: 'chain_registration_failed', finishedAt: new Date() }).where(eq(thesisJobs.thesisId, thesis.id));
          await tx.update(theses).set({ status: 'draft' }).where(and(eq(theses.id, thesis.id), eq(theses.status, 'auditing')));
        }
      }); continue;
    }
    if (action.status !== 'confirmed' || !action.txHash) continue;
    const onchain = await gateway.registered(thesis.onchainId);
    if (!same(onchain.author, registration.authorAddress) || !same(onchain.marketHash, registration.marketHash) ||
      !same(onchain.contentHash, registration.contentHash) || onchain.expiry !== Math.floor(registration.expiryAt.getTime() / 1000) || onchain.sideYes !== (thesis.side === 'yes')) throw new Error('registration_mismatch');
    await db.transaction(async tx => {
      await tx.update(thesisRegistrations).set({ confirmedAt: new Date() }).where(eq(thesisRegistrations.thesisId, thesis.id));
      await tx.update(theses).set({ registerTx: action.txHash,
        ...(author.kind === 'agent' && thesis.status === 'auditing' ? { status: 'published' as const, publishedAt: new Date() } : {}) }).where(eq(theses.id, thesis.id));
    });
  }
}

export async function processTips(db: Db, gateway: ChainGateway) {
  const rows = await db.select({ tip: tips, thesis: theses, wallet: walletAccounts, trade: trades }).from(tips)
    .innerJoin(theses, eq(theses.id, tips.thesisId)).innerJoin(walletAccounts, eq(walletAccounts.userId, tips.userId))
    .innerJoin(trades, eq(trades.id, tips.tradeId)).where(eq(tips.status, 'pending')).limit(20);
  for (const { tip, thesis, wallet, trade } of rows) {
    if (wallet.status !== 'ready' || !wallet.circleWalletId || !['filled', 'settled'].includes(trade.status)) continue;
    const action = await enqueueAction(db, { key: `tip:${gateway.escrowAddress}:${tip.id}`, kind: 'tip', walletId: wallet.circleWalletId,
      contractAddress: gateway.escrowAddress, callData: encodeFunctionData({ abi: escrowAbi, functionName: 'tip',
        args: [hex(thesis.onchainId), usdcUnits(tip.amountUsdc), hex(hashContent(tip.id))] }) });
    await db.update(tips).set({ circleTxId: action.circleTxId,
      ...(action.status === 'confirmed' ? { status: 'escrowed' as const, depositTx: action.txHash } : action.status === 'failed' ? { status: 'failed' as const } : {}) }).where(eq(tips.id, tip.id));
  }
}

/** Only the exact official Gemini contract outcome can create an oracle report. */
export async function reportOfficialOutcomes(db: Db, gateway: ChainGateway, client: Pick<GeminiPublicClient, 'getEvent'>, now = Date.now()) {
  const rows = await db.select({ registration: thesisRegistrations, market: markets }).from(thesisRegistrations)
    .innerJoin(theses, eq(theses.id, thesisRegistrations.thesisId)).innerJoin(markets, eq(markets.id, theses.marketId))
    .where(and(lt(thesisRegistrations.expiryAt, new Date(now)), eq(thesisRegistrations.escrowAddress, gateway.escrowAddress),
      sql`${thesisRegistrations.confirmedAt} is not null`)).limit(100);
  const seen = new Set<string>();
  for (const { registration, market } of rows) {
    if (seen.has(market.id)) continue; seen.add(market.id);
    const key = `outcome:${gateway.escrowAddress}:${market.id}`;
    const [prior] = await db.select().from(chainActions).where(eq(chainActions.key, key));
    if (prior?.status === 'confirmed') continue;
    const event = await client.getEvent(market.eventTicker);
    if (event?.ticker !== market.eventTicker) continue;
    const contract = event.contracts.find(c => c.instrumentSymbol === market.instrumentSymbol);
    if (!contract) continue;
    const voided = event.status === 'invalid' || contract.status === 'invalid';
    const side = contract.resolutionSide;
    if (!voided && side !== 'yes' && side !== 'no') continue;
    const expected = voided ? 3 : side === 'yes' ? 1 : 2;
    const current = await gateway.outcome(registration.marketHash);
    if (current !== 0 && current !== expected) throw new Error('official_outcome_mismatch');
    const action = await enqueueAction(db, { key, kind: 'outcome', walletId: gateway.treasuryWalletId, contractAddress: gateway.escrowAddress,
      callData: voided ? encodeFunctionData({ abi: escrowAbi, functionName: 'reportVoid', args: [hex(registration.marketHash)] })
        : encodeFunctionData({ abi: escrowAbi, functionName: 'reportOutcome', args: [hex(registration.marketHash), side === 'yes'] }) });
    if (current === expected && action.status !== 'confirmed') await db.update(chainActions).set({ status: 'confirmed' }).where(eq(chainActions.key, key));
    await db.update(markets).set({ status: voided ? 'invalid' : 'settled', resolutionSide: voided ? null : side,
      resolvedAt: new Date(contract.resolvedAt ?? event.resolvedAt ?? now) }).where(eq(markets.id, market.id));
  }
}

export async function settleTips(db: Db, gateway: ChainGateway, now = Date.now()) {
  const rows = await db.select({ tip: tips, thesis: theses, registration: thesisRegistrations, wallet: walletAccounts, market: markets }).from(tips)
    .innerJoin(theses, eq(theses.id, tips.thesisId)).innerJoin(thesisRegistrations, eq(thesisRegistrations.thesisId, tips.thesisId))
    .innerJoin(walletAccounts, eq(walletAccounts.userId, tips.userId)).innerJoin(markets, eq(markets.id, theses.marketId)).where(eq(tips.status, 'escrowed')).limit(50);
  for (const { tip, thesis, registration, wallet, market } of rows) {
    if (!same(registration.escrowAddress, gateway.escrowAddress) || !wallet.address) continue;
    const outcome = await gateway.outcome(registration.marketHash);
    const expectedOfficial = market.status === 'invalid' ? 3 : market.resolutionSide === 'yes' ? 1 : market.resolutionSide === 'no' ? 2 : 0;
    if (outcome !== 0 && outcome !== expectedOfficial) continue;
    const right = (outcome === 1 && thesis.side === 'yes') || (outcome === 2 && thesis.side === 'no');
    if (right) {
      const state = await gateway.registered(thesis.onchainId);
      if (state.settled) {
        const [action] = await db.select().from(chainActions).where(eq(chainActions.key, `settle:${gateway.escrowAddress}:${thesis.id}`));
        await db.update(tips).set({ status: 'paid', settleTx: action?.status === 'confirmed' ? action.txHash : null })
          .where(and(eq(tips.thesisId, thesis.id), eq(tips.status, 'escrowed')));
      } else await enqueueAction(db, { key: `settle:${gateway.escrowAddress}:${thesis.id}`, kind: 'settle', walletId: gateway.treasuryWalletId,
        contractAddress: gateway.escrowAddress, callData: encodeFunctionData({ abi: escrowAbi, functionName: 'settle', args: [hex(thesis.onchainId)] }) });
    } else if (outcome !== 0 || now > registration.expiryAt.getTime() + 7 * 86400_000) {
      const key = `refund:${gateway.escrowAddress}:${thesis.id}:${tip.userId}`;
      if (await gateway.tipBalance(thesis.onchainId, wallet.address) === 0n) {
        const [action] = await db.select().from(chainActions).where(eq(chainActions.key, key));
        await db.update(tips).set({ status: 'refunded', settleTx: action?.status === 'confirmed' ? action.txHash : null })
          .where(and(eq(tips.thesisId, thesis.id), eq(tips.userId, tip.userId), eq(tips.status, 'escrowed')));
      } else await enqueueAction(db, { key, kind: 'refund', walletId: gateway.treasuryWalletId, contractAddress: gateway.escrowAddress,
        callData: encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [hex(thesis.onchainId), getAddress(wallet.address)] }) });
    }
  }
}

export async function settleCopies(db: Db, client: Pick<GeminiPublicClient, 'getEvent'>, now = Date.now()) {
  const rows = await db.select({ trade: trades, market: markets }).from(trades).innerJoin(markets, eq(markets.id, trades.marketId))
    .where(and(eq(trades.isAuthorPosition, false), eq(trades.mode, 'paper'), eq(trades.status, 'filled'), lt(markets.expiryAt, new Date(now)))).limit(100);
  let count = 0;
  for (const { trade, market } of rows) {
    if (!trade.userId) continue;
    const event = await client.getEvent(market.eventTicker);
    const contract = event?.ticker === market.eventTicker ? event.contracts.find(c => c.instrumentSymbol === market.instrumentSymbol) : null;
    if (!contract) continue;
    const voided = event?.status === 'invalid' || contract.status === 'invalid', side = contract.resolutionSide;
    if (!voided && side !== 'yes' && side !== 'no') continue;
    count += await db.transaction(async tx => {
      const [user] = await tx.select().from(users).where(eq(users.id, trade.userId!)).for('update');
      const [current] = await tx.select().from(trades).where(eq(trades.id, trade.id));
      if (!user || current?.status !== 'filled') return 0;
      const payout = voided ? units(current.costUsd) : current.side === side ? units(current.quantity) : 0n;
      await tx.update(trades).set({ status: 'settled', payoutUsd: decimal(payout) }).where(eq(trades.id, trade.id));
      await tx.update(users).set({ paperBalanceUsd: decimal(units(user.paperBalanceUsd) + payout) }).where(eq(users.id, user.id));
      return 1;
    });
  }
  return count;
}

export async function runEscrowCycle(db: Db, gateway: ChainGateway, client: Pick<GeminiPublicClient, 'getEvent'>) {
  await gateway.assertReady();
  const errors: string[] = [];
  const actions = await db.select().from(chainActions).where(inArray(chainActions.status, ['pending', 'submitted'])).orderBy(asc(chainActions.createdAt)).limit(12);
  for (const action of actions) { try { await advanceAction(db, gateway, action.key); } catch { errors.push(`action:${action.key}`); } }
  const wallets = await db.select().from(walletAccounts).where(inArray(walletAccounts.status, ['queued', 'funding', 'approving'])).limit(10);
  for (const wallet of wallets) { try { await advanceWallet(db, gateway, wallet.ownerKey); } catch { errors.push(`wallet:${wallet.ownerKey}`); } }
  for (const [stage, run] of [
    ['registrations', () => enqueueRegistrations(db, gateway)], ['registration confirmations', () => confirmRegistrations(db, gateway)],
    ['tips', () => processTips(db, gateway)], ['official outcomes', () => reportOfficialOutcomes(db, gateway, client)], ['tip settlement', () => settleTips(db, gateway)],
  ] as const) { try { await run(); } catch { errors.push(stage); } }
  let copiesSettled = 0;
  try { copiesSettled = await settleCopies(db, client); } catch { errors.push('copy settlement'); }
  return { actions: actions.length, wallets: wallets.length, copiesSettled, errors };
}
