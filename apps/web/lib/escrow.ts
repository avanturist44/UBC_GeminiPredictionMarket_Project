import 'server-only';
import { createGeminiPublicClient } from '@thesis/core';
import { eq, markets, theses, walletAccounts } from '@thesis/db';
import { createArcGateway, PublicationError, usdcDecimal } from '@thesis/services';
import { publicationDb } from './publication-http';
let gateway: ReturnType<typeof createArcGateway> | undefined;
const client = createGeminiPublicClient({ logger: { warn() {} } });
export function escrowGateway() {
  if (process.env.ESCROW_ENABLED !== 'true') throw new PublicationError('chain_not_configured', 503);
  return gateway ??= createArcGateway();
}
export function publicGeminiClient() { return client; }
export async function thesisMarket(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PublicationError('not_found', 404);
  const [row] = await publicationDb().select({ market: markets }).from(theses).innerJoin(markets, eq(markets.id, theses.marketId)).where(eq(theses.id, id));
  if (!row) throw new PublicationError('not_found', 404); return row.market;
}
export async function walletSnapshot(userId: string) {
  const [wallet] = await publicationDb().select().from(walletAccounts).where(eq(walletAccounts.userId, userId));
  const at = Date.now();
  const funds = wallet?.address ? await Promise.all([escrowGateway().balance(wallet.address), escrowGateway().allowance(wallet.address)]) : [0n, 0n];
  return { view: { status: wallet?.status ?? 'not_created', address: wallet?.address ?? null,
    balanceUsdc: usdcDecimal(funds[0]!), allowanceUsdc: usdcDecimal(funds[1]!), errorCode: wallet?.errorCode ?? null },
    funds: { ready: wallet?.status === 'ready', balance: funds[0]!, allowance: funds[1]!, observedAtMs: at } };
}
