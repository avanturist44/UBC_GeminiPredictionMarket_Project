// Runs the whole tip lifecycle against the deployed escrow on Arc testnet:
//   pnpm --filter @thesis/worker verify:escrow
// It registers a test thesis, tips it from a new Circle wallet, reports the outcome and pays
// the author. It spends about 2 test USDC from the treasury and prints no secrets.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { arcRpcUrls, marketOnchainId, thesisOnchainId } from '@thesis/core';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createEscrowChain } from './chain';
import { createCircleWallets, type CircleWallets } from './circle';

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
};
const EXPLORER = 'https://explorer.testnet.arc.io/tx/';
const usdc = (units: bigint) => `${(Number(units) / 1e6).toFixed(2)} USDC`;

async function wait(circle: CircleWallets, id: string, label: string): Promise<string | null> {
  const started = Date.now();
  for (let i = 0; i < 90; i += 1) {
    const tx = await circle.transaction(id);
    if (tx.state === 'complete') {
      console.log(`   ${label}: complete in ${((Date.now() - started) / 1000).toFixed(0)}s ${tx.txHash ? EXPLORER + tx.txHash : ''}`);
      return tx.txHash;
    }
    if (tx.state === 'failed') throw new Error(`${label} failed: ${tx.error}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${label} did not finish in time`);
}

(async () => {
  const usdcAddress = (process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000') as Address;
  const chain = createEscrowChain({
    rpcUrls: arcRpcUrls(process.env.ARC_RPC_URL),
    chainId: Number(process.env.ARC_CHAIN_ID || 5042002),
    escrowAddress: need('ESCROW_ADDRESS') as Address,
    usdcAddress,
    registrarKey: need('REGISTRAR_KEY') as Hex,
    resolverKey: need('RESOLVER_KEY') as Hex,
  });
  const circle = createCircleWallets({
    apiKey: need('CIRCLE_API_KEY'),
    entitySecret: need('CIRCLE_ENTITY_SECRET'),
    walletSetId: need('CIRCLE_WALLET_SET_ID'),
    treasuryWalletId: need('CIRCLE_TREASURY_WALLET_ID'),
    usdcAddress,
  });

  const run = randomUUID();
  const id = thesisOnchainId(run) as Hex;
  const marketId = marketOnchainId(`VERIFY-ESCROW-${run}`) as Hex;
  // A throwaway address stands in for the author, so the payout is easy to see.
  const author = privateKeyToAccount(generatePrivateKey()).address;

  console.log('1. A Circle smart contract account for the tipper');
  const wallet = await circle.createWallet(run);
  console.log(`   wallet ${wallet.address}`);
  await wait(circle, await circle.fundFromTreasury(wallet.address, '2', randomUUID()), 'funded with 2 USDC');
  await wait(
    circle,
    await circle.execute({
      walletId: wallet.walletId,
      contractAddress: usdcAddress,
      abiFunctionSignature: 'approve(address,uint256)',
      abiParameters: [chain.escrowAddress, '20000000'],
      idempotencyKey: randomUUID(),
    }),
    'approved the escrow for 20 USDC',
  );
  console.log(`   balance ${usdc(await chain.usdcBalance(wallet.address as Address))}, allowance ${usdc(await chain.usdcAllowance(wallet.address as Address))}`);

  console.log('2. The registrar records the thesis');
  const registered = await chain.registerThesis({
    id,
    author,
    marketId,
    sideYes: true,
    contentHash: thesisOnchainId(`content-${run}`) as Hex,
    expiry: new Date(Date.now() + 10 * 60_000),
  });
  console.log(`   ${EXPLORER}${registered}`);
  console.log(`   registering again sends nothing: ${(await chain.registerThesis({ id, author, marketId, sideYes: true, contentHash: id, expiry: new Date(Date.now() + 600_000) })) === null}`);

  console.log('3. The tipper tips 0.25 USDC');
  await wait(
    circle,
    await circle.execute({
      walletId: wallet.walletId,
      contractAddress: chain.escrowAddress,
      abiFunctionSignature: 'tip(bytes32,uint256)',
      abiParameters: [id, '250000'],
      idempotencyKey: randomUUID(),
    }),
    'tip',
  );
  console.log(`   held for the tipper: ${usdc(await chain.tipOf(id, wallet.address as Address))}; thesis total: ${usdc((await chain.thesis(id))!.totalTips)}`);

  console.log('4. The resolver reports that YES won, and the author is paid');
  console.log(`   ${EXPLORER}${await chain.reportOutcome(marketId, 'yes')}`);
  console.log(`   market state: ${await chain.marketState(marketId)}; reporting again sends nothing: ${(await chain.reportOutcome(marketId, 'no')) === null}`);
  console.log(`   ${EXPLORER}${await chain.settle(id)}`);
  console.log(`   author received ${usdc(await chain.usdcBalance(author))}; settling again sends nothing: ${(await chain.settle(id)) === null}`);
  console.log(`   tipper has ${usdc(await chain.usdcBalance(wallet.address as Address))} left`);
})().catch((error: unknown) => {
  const e = error as { message?: string; shortMessage?: string; response?: { data?: unknown } };
  console.error('FAILED:', e.shortMessage ?? e.message ?? error);
  if (e.response?.data) console.error('Circle said:', JSON.stringify(e.response.data).slice(0, 400));
  process.exit(1);
});
