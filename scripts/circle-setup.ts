/**
 * One-time Circle setup: creates the wallet set and the treasury wallet on Arc testnet,
 * following https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet
 *
 *   pnpm circle:setup
 *
 * Needs CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in .env. Safe to re-run: anything already
 * named in .env (CIRCLE_WALLET_SET_ID, CIRCLE_TREASURY_WALLET_ID) is looked up, not recreated.
 * Prints the two IDs and the treasury address; it never prints a secret.
 *
 * The treasury is an EOA, as in Circle's guide: it holds faucet USDC, which is also Arc's gas
 * token, so it pays its own gas. User wallets (Phase 4) are smart contract accounts instead.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const BLOCKCHAIN = 'ARC-TESTNET';

const rootEnv = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error('Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in .env first');
  }
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  let walletSetId = process.env.CIRCLE_WALLET_SET_ID;
  if (walletSetId) {
    console.log(`Wallet set: reusing ${walletSetId} from .env`);
  } else {
    const res = await client.createWalletSet({ name: 'Thesis Market' });
    walletSetId = res.data?.walletSet?.id;
    if (!walletSetId) throw new Error('Wallet set creation failed: no ID returned');
    console.log(`Wallet set: created ${walletSetId}`);
  }

  let treasuryId = process.env.CIRCLE_TREASURY_WALLET_ID;
  let address: string | undefined;
  if (treasuryId) {
    const res = await client.getWallet({ id: treasuryId });
    address = res.data?.wallet?.address;
    console.log(`Treasury wallet: reusing ${treasuryId} from .env`);
  } else {
    const res = await client.createWallets({
      walletSetId,
      blockchains: [BLOCKCHAIN],
      count: 1,
      accountType: 'EOA',
      metadata: [{ name: 'Treasury', refId: 'treasury' }],
    });
    const wallet = res.data?.wallets?.[0];
    if (!wallet?.id) throw new Error('Treasury wallet creation failed: no ID returned');
    treasuryId = wallet.id;
    address = wallet.address;
    console.log(`Treasury wallet: created ${treasuryId}`);
  }

  console.log('');
  console.log(`CIRCLE_WALLET_SET_ID=${walletSetId}`);
  console.log(`CIRCLE_TREASURY_WALLET_ID=${treasuryId}`);
  console.log(`# Treasury address on ${BLOCKCHAIN} (send faucet USDC here): ${address ?? 'unknown'}`);
}

main().catch((err: unknown) => {
  const e = err as { message?: string; response?: { status?: number; data?: unknown } };
  console.error('Error:', e.message ?? err);
  if (e.response?.data) console.error('Circle said:', JSON.stringify(e.response.data));
  process.exit(1);
});
