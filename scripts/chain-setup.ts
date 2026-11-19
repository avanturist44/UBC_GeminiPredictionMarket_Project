/**
 * One-time chain setup for Arc testnet: `pnpm chain:setup`
 *
 * 1. Makes sure REGISTRAR_KEY and RESOLVER_KEY exist in .env, creating them if missing.
 *    These are the two privileged accounts of the escrow: the registrar records theses, the
 *    resolver reports market outcomes. They are plain keys the worker holds.
 * 2. Sends each of them a little test USDC from the Circle treasury wallet, for gas.
 *
 * Safe to re-run: existing keys are kept, and an account that already has gas is not topped
 * up. It prints addresses and balances only, never a key. Everything here is testnet money.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, formatEther, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const rootEnv = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const RPC = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.io';
const USDC = process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
/** USDC is Arc's gas token. Its native balance has 18 decimals. */
const MIN_GAS = 1n * 10n ** 18n;
const TOP_UP = '3';

function ensureKey(name: 'REGISTRAR_KEY' | 'RESOLVER_KEY'): Hex {
  const existing = process.env[name];
  if (existing) return existing as Hex;
  const key = generatePrivateKey();
  appendFileSync(rootEnv, `\n# Created by pnpm chain:setup. Testnet only. Never commit.\n${name}=${key}\n`);
  process.env[name] = key;
  console.log(`${name}: created and written to .env`);
  return key;
}

async function main(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const treasuryId = process.env.CIRCLE_TREASURY_WALLET_ID;
  if (!apiKey || !entitySecret || !treasuryId) throw new Error('Run pnpm circle:setup first: the Circle settings are missing from .env');

  const chain = createPublicClient({ transport: http(RPC) });
  console.log(`Chain ID ${await chain.getChainId()} at ${RPC}`);
  const circle = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const balances = (await circle.getWalletTokenBalance({ id: treasuryId })).data?.tokenBalances ?? [];
  const usdc = balances.find((b) => b.token?.tokenAddress?.toLowerCase() === USDC.toLowerCase());
  if (!usdc?.token?.id) throw new Error('The treasury wallet holds no USDC. Fund it from https://faucet.circle.com (Arc Testnet).');
  console.log(`Treasury: ${usdc.amount} USDC`);

  for (const name of ['REGISTRAR_KEY', 'RESOLVER_KEY'] as const) {
    const address = privateKeyToAccount(ensureKey(name)).address;
    const role = name === 'REGISTRAR_KEY' ? 'Registrar' : 'Resolver';
    const gas = await chain.getBalance({ address });
    if (gas >= MIN_GAS) {
      console.log(`${role} ${address}: has ${formatEther(gas)} USDC for gas`);
      continue;
    }
    const sent = await circle.createTransaction({
      walletId: treasuryId,
      tokenId: usdc.token.id,
      destinationAddress: address,
      amount: [TOP_UP],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    const id = sent.data?.id;
    if (!id) throw new Error(`The transfer to the ${role.toLowerCase()} was not accepted`);
    let state = sent.data?.state ?? 'INITIATED';
    for (let i = 0; i < 40 && !['COMPLETE', 'CONFIRMED', 'FAILED', 'DENIED', 'CANCELLED'].includes(state); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      state = (await circle.getTransaction({ id })).data?.transaction?.state ?? state;
    }
    console.log(`${role} ${address}: sent ${TOP_UP} USDC from the treasury (${state}); now ${formatEther(await chain.getBalance({ address }))} USDC`);
  }
}

main().catch((err: unknown) => {
  const e = err as { message?: string; response?: { data?: unknown } };
  console.error('Error:', e.message ?? err);
  if (e.response?.data) console.error('Circle said:', JSON.stringify(e.response.data).slice(0, 400));
  process.exit(1);
});
