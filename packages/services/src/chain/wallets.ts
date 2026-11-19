import { and, authors, chainActions, chainControl, eq, gte, users, walletAccounts, type Db } from '@thesis/db';
import { encodeFunctionData, erc20Abi, getAddress } from 'viem';
import { enqueueAction } from './actions';
import { USDC_ADDRESS } from './abi';
import type { ChainGateway } from './gateway';
import { PublicationError } from '../publication';

export async function ensureWallet(db: Db, owner: { userId: string } | { authorId: string }, now = Date.now()) {
  const userId = 'userId' in owner ? owner.userId : null;
  const authorId = 'authorId' in owner ? owner.authorId : null;
  const ownerKey = userId ? `user:${userId}` : `agent:${authorId}`;
  return db.transaction(async tx => {
    await tx.insert(chainControl).values({ id: 1 }).onConflictDoNothing();
    await tx.select().from(chainControl).where(eq(chainControl.id, 1)).for('update');
    const [existing] = await tx.select().from(walletAccounts).where(eq(walletAccounts.ownerKey, ownerKey));
    if (existing) return existing;
    if (userId) {
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user || user.tradingMode !== 'paper') throw new PublicationError('session_required', 401);
      const today = new Date(new Date(now).toISOString().slice(0, 10));
      const allocated = await tx.select().from(walletAccounts).where(gte(walletAccounts.createdAt, today));
      if (allocated.filter(row => row.userId !== null).length >= 20) throw new PublicationError('wallet_daily_limit', 429);
    } else {
      const [author] = await tx.select().from(authors).where(eq(authors.id, authorId!));
      if (author?.kind !== 'agent') throw new PublicationError('wallet_unavailable');
    }
    const [wallet] = await tx.insert(walletAccounts).values({ ownerKey, userId, authorId, createdAt: new Date(now) }).returning();
    return wallet!;
  });
}

export async function advanceWallet(db: Db, gateway: ChainGateway, ownerKey: string) {
  return db.transaction(async tx => {
    const [wallet] = await tx.select().from(walletAccounts).where(eq(walletAccounts.ownerKey, ownerKey)).for('update');
    if (!wallet || ['ready', 'failed'].includes(wallet.status)) return wallet;
    if (wallet.status === 'queued') {
      const created = await gateway.createWallet(ownerKey, wallet.createKey);
      if (wallet.userId) {
        await tx.update(users).set({ circleWalletId: created.id, walletAddress: created.address }).where(eq(users.id, wallet.userId));
        await tx.update(authors).set({ walletAddress: created.address }).where(eq(authors.userId, wallet.userId));
        await enqueueAction(tx, { key: `fund:${ownerKey}`, kind: 'fund', walletId: gateway.treasuryWalletId,
          contractAddress: USDC_ADDRESS, amountUsdc: '2.000000', destination: created.address });
      } else await tx.update(authors).set({ walletAddress: created.address }).where(eq(authors.id, wallet.authorId!));
      const [updated] = await tx.update(walletAccounts).set({ circleWalletId: created.id, address: created.address,
        status: wallet.userId ? 'funding' : 'ready', updatedAt: new Date() }).where(eq(walletAccounts.ownerKey, ownerKey)).returning();
      return updated;
    }
    const key = wallet.status === 'funding' ? `fund:${ownerKey}` : `approve:${ownerKey}:${gateway.escrowAddress}`;
    const [action] = await tx.select().from(chainActions).where(eq(chainActions.key, key));
    if (action?.status === 'failed') {
      const [failed] = await tx.update(walletAccounts).set({ status: 'failed', errorCode: 'wallet_transaction_failed', updatedAt: new Date() }).where(eq(walletAccounts.ownerKey, ownerKey)).returning(); return failed;
    }
    if (action?.status !== 'confirmed') return wallet;
    if (wallet.status === 'funding') {
      if (await gateway.balance(wallet.address!) < 2_000_000n) return wallet;
      await enqueueAction(tx, { key: `approve:${ownerKey}:${gateway.escrowAddress}`, kind: 'approve', walletId: wallet.circleWalletId!,
        contractAddress: USDC_ADDRESS, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [gateway.escrowAddress, 20_000_000n] }) });
      const [updated] = await tx.update(walletAccounts).set({ status: 'approving', updatedAt: new Date() }).where(eq(walletAccounts.ownerKey, ownerKey)).returning(); return updated;
    }
    if (await gateway.allowance(wallet.address!) < 20_000_000n) return wallet;
    const [ready] = await tx.update(walletAccounts).set({ status: 'ready', updatedAt: new Date() }).where(eq(walletAccounts.ownerKey, ownerKey)).returning(); return ready;
  });
}
