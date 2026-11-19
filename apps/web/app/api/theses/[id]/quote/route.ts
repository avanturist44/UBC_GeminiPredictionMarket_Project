import { z } from 'zod';
import { consumeUserWrite, CopyAmount, CopyTip, openPublicationQuote, PublicationError, quoteCopy } from '@thesis/services';
import { escrowGateway, publicGeminiClient, thesisMarket } from '@/lib/escrow';
import { json, publicationDb, publicationFailure, requestJson, viewerId } from '@/lib/publication-http';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const input = z.strictObject({ amountUsd: CopyAmount, tipUsdc: CopyTip }).parse(await requestJson(request));
    const userId = await viewerId(); if (!userId) throw new PublicationError('session_required', 401);
    await consumeUserWrite(publicationDb(), userId);
    const gateway = escrowGateway(); await gateway.assertReady();
    const { id } = await context.params, market = await thesisMarket(id);
    const lease = await openPublicationQuote(publicGeminiClient(), market);
    try { return json(await quoteCopy(publicationDb(), id, userId, input.amountUsd, input.tipUsdc, lease.read(),
      { escrowAddress: gateway.escrowAddress, secret: process.env.SESSION_SECRET ?? '' })); }
    finally { lease.close(); }
  } catch (error) { return publicationFailure(error); }
}
