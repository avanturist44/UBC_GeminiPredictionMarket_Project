import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Hex } from 'viem';
import { chainActions, eq, type Db } from '@thesis/db';
import { createTestDb } from '../../db/src/testing';
import { enqueueAction, advanceAction } from '../src/chain/actions';
import { escrowAbi, usdcUnits, usdcDecimal } from '../src/chain/abi';
import { provesAction } from '../src/chain/receipts';
import { arcConfig, type ChainAction, type ChainGateway } from '../src/chain/gateway';
const escrow = '0x1111111111111111111111111111111111111111' as const;
const tipper = '0x2222222222222222222222222222222222222222' as const;
const id = `0x${'ab'.repeat(32)}` as Hex, request = `0x${'cd'.repeat(32)}` as Hex;
const calldata = encodeFunctionData({ abi: escrowAbi, functionName: 'tip', args: [id, 100_000n, request] });
function event(amount = 100_000n, address = escrow) {
  return { address, topics: encodeEventTopics({ abi: escrowAbi, eventName: 'Tipped', args: { id, tipper, requestId: request } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]) };
}
const action = { key: 'fixture-tip', idempotencyKey: randomUUID(), kind: 'tip', walletId: randomUUID(), contractAddress: escrow,
  callData: calldata, amountUsdc: null, destination: null, status: 'submitted', circleTxId: null, txHash: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() } satisfies ChainAction;
describe('chain boundaries and receipt proof', () => {
  it('uses exact six-decimal token precision separately from native gas units', () => {
    expect(usdcUnits('0.100001')).toBe(100_001n); expect(usdcDecimal(100_001n)).toBe('0.100001');
    expect(() => usdcUnits('0.0000001')).toThrow(); expect(() => usdcUnits('-1')).toThrow();
  });
  it('requires the exact escrow event, amount, request and tipper', () => {
    expect(provesAction(action, [event()], tipper)).toBe(true);
    expect(provesAction(action, [], tipper)).toBe(false);
    expect(provesAction(action, [event(200_000n)], tipper)).toBe(false);
    expect(provesAction(action, [{ ...event(), address: tipper }], tipper)).toBe(false);
    expect(provesAction(action, [event()], escrow)).toBe(false);
  });
  it('rejects production keys, mainnet chain IDs and arbitrary token addresses', () => {
    const env = { CIRCLE_API_KEY: 'TEST_API_KEY:fixture:fixture', CIRCLE_ENTITY_SECRET: 'a'.repeat(64),
      CIRCLE_TREASURY_WALLET_ID: randomUUID(), CIRCLE_WALLET_SET_ID: randomUUID(), ESCROW_ADDRESS: escrow, ESCROW_CODE_HASH: id };
    expect(arcConfig(env).escrowAddress).toBe(escrow);
    for (const changes of [{ CIRCLE_API_KEY: 'LIVE_API_KEY:fixture' }, { ARC_CHAIN_ID: '5042' }, { USDC_ADDRESS: escrow }, { TRADING_MODE: 'gemini' }]) {
      expect(() => arcConfig({ ...env, ...changes })).toThrow();
    }
  });
});
let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }); afterAll(() => close());
describe('durable Circle outbox', () => {
  it('reuses its saved UUID after an ambiguous response and confirms only receipt-proven execution', async () => {
    const remote = new Map<string, string>(); let calls = 0, loseResponse = true;
    const gateway = { assertReady: async () => {}, submit: async (row: ChainAction) => {
      calls++; if (!remote.has(row.idempotencyKey)) remote.set(row.idempotencyKey, randomUUID());
      if (loseResponse) { loseResponse = false; throw new Error('response lost after submission'); }
      return remote.get(row.idempotencyKey)!;
    }, inspect: async () => ({ state: 'confirmed', hash: id }), receipt: async () => ({ success: true, logs: [event()] }),
      prove: async (row: ChainAction, logs: unknown[]) => provesAction(row, logs, tipper) } as unknown as ChainGateway;
    const row = await enqueueAction(db, { key: 'ambiguous', kind: 'tip', walletId: action.walletId, contractAddress: escrow, callData: calldata });
    await expect(advanceAction(db, gateway, row.key)).rejects.toThrow();
    expect((await advanceAction(db, gateway, row.key)).status).toBe('submitted');
    expect((await advanceAction(db, gateway, row.key)).status).toBe('confirmed');
    expect((await advanceAction(db, gateway, row.key)).status).toBe('confirmed');
    expect(calls).toBe(2); expect(remote.size).toBe(1);
    await expect(enqueueAction(db, { key: row.key, kind: 'tip', walletId: action.walletId, contractAddress: escrow, callData: '0x1234' })).rejects.toThrow('chain_action_conflict');
  });
  it('keeps unknown receipts pending and rejects successful bundles without the requested event', async () => {
    let receipt: { success: boolean; logs: unknown[] } | null = null;
    let omitHash = false;
    const gateway = { assertReady: async () => {}, inspect: async () => ({ state: 'failed', hash: omitHash ? undefined : id }), receipt: async () => receipt,
      prove: async () => false } as unknown as ChainGateway;
    await enqueueAction(db, { key: 'receipt-missing', kind: 'tip', walletId: action.walletId, contractAddress: escrow, callData: calldata, circleTxId: randomUUID(), status: 'submitted' });
    expect((await advanceAction(db, gateway, 'receipt-missing')).status).toBe('submitted');
    omitHash = true;
    expect((await advanceAction(db, gateway, 'receipt-missing')).status).toBe('submitted');
    receipt = { success: true, logs: [] };
    expect((await advanceAction(db, gateway, 'receipt-missing')).status).toBe('failed');
  });
});
