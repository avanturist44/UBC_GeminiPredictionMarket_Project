import { chainActions, eq, type Db } from '@thesis/db';
import type { ChainGateway, ChainAction } from './gateway';
import { usdcUnits } from './abi';
export async function enqueueAction(db: Db, input: typeof chainActions.$inferInsert) {
  await db.insert(chainActions).values(input).onConflictDoNothing();
  const [action] = await db.select().from(chainActions).where(eq(chainActions.key, input.key));
  if (!action || action.kind !== input.kind || action.walletId !== input.walletId || action.contractAddress.toLowerCase() !== input.contractAddress.toLowerCase() ||
    (action.callData ?? null) !== (input.callData ?? null) || (action.destination ?? null) !== (input.destination ?? null) ||
    usdcUnits(action.amountUsdc ?? '0') !== usdcUnits(input.amountUsdc ?? '0')) throw new Error('chain_action_conflict');
  return action;
}
/** The row lock and persisted Circle UUID survive process crashes and ambiguous network responses. */
export async function advanceAction(db: Db, gateway: ChainGateway, key: string): Promise<ChainAction> {
  return db.transaction(async tx => {
    const [action] = await tx.select().from(chainActions).where(eq(chainActions.key, key)).for('update');
    if (!action) throw new Error('chain_action_missing');
    if (action.status === 'confirmed' || action.status === 'failed') return action;
    await gateway.assertReady();
    if (!action.circleTxId) {
      const circleTxId = await gateway.submit(action);
      const [updated] = await tx.update(chainActions).set({ circleTxId, status: 'submitted', updatedAt: new Date() }).where(eq(chainActions.key, key)).returning();
      return updated!;
    }
    const check = await gateway.inspect(action.circleTxId);
    // Once observed, preserve the transaction identity through incomplete API responses.
    const hash = check.hash ?? action.txHash;
    const receipt = hash ? await gateway.receipt(hash) : null;
    const proven = !!receipt?.success && await gateway.prove(action, receipt.logs);
    const failed = receipt ? !proven : check.state === 'failed' && !hash;
    const status = proven ? 'confirmed' : failed ? 'failed' : 'submitted';
    const [updated] = await tx.update(chainActions).set({ txHash: check.hash ?? action.txHash, status,
      errorCode: failed ? 'chain_transaction_failed' : null, updatedAt: new Date() }).where(eq(chainActions.key, key)).returning();
    return updated!;
  });
}
