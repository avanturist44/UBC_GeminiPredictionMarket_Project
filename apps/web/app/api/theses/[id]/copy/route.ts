import { consumeUserWrite, copyTrade, CopyInput, getCopy, openPublicationQuote, PublicationError } from '@thesis/services';
import { escrowGateway, publicGeminiClient, thesisMarket, walletSnapshot } from '@/lib/escrow';
import { json, publicationDb, publicationFailure, requestJson, viewerId } from '@/lib/publication-http';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const input = CopyInput.parse(await requestJson(request)), userId = await viewerId();
    if (!userId) throw new PublicationError('session_required', 401);
    await consumeUserWrite(publicationDb(), userId);
    const { id } = await context.params, db = publicationDb(), gateway = escrowGateway();
    const common = { escrowAddress: gateway.escrowAddress, secret: process.env.SESSION_SECRET ?? '',
      enabled: () => process.env.TRADING_ENABLED !== 'false' && process.env.ESCROW_ENABLED === 'true' };
    if (await getCopy(db, input.idempotencyKey, userId)) {
      await copyTrade(db, id, userId, input, { ...common, readQuote: () => null,
        readFunds: () => ({ ready: false, balance: 0n, allowance: 0n, observedAtMs: Date.now() }) });
      return json(await getCopy(db, input.idempotencyKey, userId));
    }
    await gateway.assertReady();
    const market = await thesisMarket(id), lease = await openPublicationQuote(publicGeminiClient(), market);
    try {
      const snapshot = input.tipUsdc && Number(input.tipUsdc) > 0 ? await walletSnapshot(userId) : undefined;
      await copyTrade(db, id, userId, input, { ...common, readQuote: lease.read,
        readFunds: () => snapshot?.funds ?? { ready: false, balance: 0n, allowance: 0n, observedAtMs: Date.now() } });
      return json(await getCopy(db, input.idempotencyKey, userId), 201);
    } finally { lease.close(); }
  } catch (error) { return publicationFailure(error); }
}
