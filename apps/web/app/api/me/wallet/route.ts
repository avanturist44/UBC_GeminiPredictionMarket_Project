import { z } from 'zod';
import { consumeUserWrite, ensureWallet, PublicationError } from '@thesis/services';
import { escrowGateway, walletSnapshot } from '@/lib/escrow';
import { json, publicationDb, publicationFailure, requestJson, viewerId } from '@/lib/publication-http';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { const id = await viewerId(); if (!id) throw new PublicationError('session_required', 401);
    return json((await walletSnapshot(id)).view);
  } catch (error) { return publicationFailure(error); }
}
export async function POST(request: Request) {
  try {
    z.strictObject({}).parse(await requestJson(request));
    const id = await viewerId(); if (!id) throw new PublicationError('session_required', 401);
    await consumeUserWrite(publicationDb(), id); await escrowGateway().assertReady();
    await ensureWallet(publicationDb(), { userId: id });
    return json((await walletSnapshot(id)).view, 202);
  } catch (error) { return publicationFailure(error); }
}
