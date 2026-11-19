import 'server-only';
import { arcRpcUrls } from '@thesis/core';
import { usdcUnitsToText } from './format';

/**
 * A wallet's test USDC on Arc testnet, read straight from the token contract. The worker
 * moves the money; this only looks. A failed or slow read returns null and the page shows
 * no figure instead of a wrong one.
 *
 * The dedicated endpoint (`ARC_RPC_URL`) is asked first, then Arc's public nodes.
 */

const RPC_URLS = arcRpcUrls(process.env.ARC_RPC_URL);
const USDC = process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const CACHE_MS = 10_000;
const TIMEOUT_MS = 1500;

const cache = new Map<string, { at: number; value: string }>();
/** When the chain last failed to answer. Reads pause for a while after, so pages stay fast. */
let failedAt = 0;

export async function readTipBalance(address: string | null, now = Date.now()): Promise<string | null> {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const key = address.toLowerCase();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  if (now - failedAt < CACHE_MS) return cached?.value ?? null;
  for (const url of RPC_URLS) {
    const units = await balanceFrom(url, key);
    if (units === null) continue;
    const value = usdcUnitsToText(units);
    cache.set(key, { at: now, value });
    if (cache.size > 2000) cache.clear();
    return value;
  }
  failedAt = now;
  return cached?.value ?? null;
}

/** `balanceOf` from one node, or null if it did not answer properly in time. */
async function balanceFrom(url: string, address: string): Promise<bigint | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // balanceOf(address)
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: USDC, data: `0x70a08231${address.slice(2).padStart(64, '0')}` }, 'latest'],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    const body = (await response.json()) as { result?: unknown };
    if (typeof body.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.result)) return null;
    return BigInt(body.result);
  } catch {
    return null;
  }
}
