import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createEscrowChain } from '../src/chain';

const TOKEN = 'abc123secrettoken';
const OWNER = '0x00000000000000000000000000000000000000aa';
const KEY_A = `0x${'1'.repeat(64)}` as const;
const KEY_B = `0x${'2'.repeat(64)}` as const;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A JSON-RPC node that answers every request with `reply`, and counts requests. */
async function node(reply: (body: { id: number; method: string }) => { status: number; json: unknown }) {
  const seen = { requests: 0 };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.requests += 1;
      const body = JSON.parse(raw) as { id: number; method: string };
      const { status, json } = reply(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const rateLimited = () => node((body) => ({ status: 200, json: { jsonrpc: '2.0', id: body.id, error: { code: -32005, message: 'rate limit exceeded' } } }));
const down = () => node(() => ({ status: 503, json: { error: 'unavailable' } }));
const balanceOf = (units: bigint) =>
  node((body) => ({ status: 200, json: { jsonrpc: '2.0', id: body.id, result: `0x${units.toString(16).padStart(64, '0')}` } }));

const chainWith = (rpcUrls: string[]) =>
  createEscrowChain({
    rpcUrls,
    chainId: 5042002,
    escrowAddress: '0x00000000000000000000000000000000000e5c20',
    usdcAddress: '0x3600000000000000000000000000000000000000',
    registrarKey: KEY_A,
    resolverKey: KEY_B,
  });

describe('createEscrowChain', () => {
  it('answers from the next node when the first is rate-limited', async () => {
    const busy = await rateLimited();
    const spare = await balanceOf(1_250_000n);
    const chain = chainWith([`${busy.url}/${TOKEN}/`, spare.url]);
    expect(await chain.usdcBalance(OWNER)).toBe(1_250_000n);
    expect(busy.seen.requests).toBeGreaterThan(0);
  }, 20_000);

  it('answers from the next node when the first is down', async () => {
    const broken = await down();
    const spare = await balanceOf(7n);
    expect(await chainWith([`${broken.url}/${TOKEN}/`, spare.url]).usdcBalance(OWNER)).toBe(7n);
  }, 20_000);

  it('never puts the endpoint token in an error, even when every node fails', async () => {
    const first = await down();
    const second = await rateLimited();
    const error = await chainWith([`${first.url}/${TOKEN}/`, second.url])
      .usdcBalance(OWNER)
      .then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toContain(TOKEN);
    expect(error!.message.length).toBeGreaterThan(0);
  }, 30_000);
});
