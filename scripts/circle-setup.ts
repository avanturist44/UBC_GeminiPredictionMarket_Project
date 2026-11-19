/**
 * One-time Circle setup: creates the wallet set and the treasury wallet on Arc testnet,
 * following https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet
 *
 *   pnpm circle:setup
 *
 * Needs CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in .env. Safe to re-run: anything already
 * named in .env (CIRCLE_WALLET_SET_ID, CIRCLE_TREASURY_WALLET_ID) is looked up, not recreated.
 * Saves the two IDs in the ignored root .env and prints them with the treasury address; it never prints a secret.
 *
 * The treasury is an EOA, as in Circle's guide: it holds faucet USDC, which is also Arc's gas
 * token, so it pays its own gas. User wallets (Phase 4) are smart contract accounts instead.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const BLOCKCHAIN = 'ARC-TESTNET';

const rootEnv = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** Persist public wallet IDs immediately so a partial setup can be resumed without duplicates. */
function saveId(key: 'CIRCLE_WALLET_SET_ID' | 'CIRCLE_TREASURY_WALLET_ID', value: string) {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Circle returned an invalid wallet identifier');
  const source = readFileSync(rootEnv, 'utf8');
  const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'm');
  const line = `${key}=${value}`;
  writeFileSync(rootEnv, pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`);
}

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
    saveId('CIRCLE_WALLET_SET_ID', walletSetId);
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
    saveId('CIRCLE_TREASURY_WALLET_ID', treasuryId);
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
  console.error('Circle setup failed. Check the configured test key and registered entity secret; saved wallet IDs were preserved.');
  if (e.response?.status) console.error('HTTP status:', e.response.status);
  process.exit(1);
});
