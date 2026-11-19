/** One-time TEST account registration. Never prints the API key, entity secret or recovery contents. */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets';

const root = new URL('../', import.meta.url);
const envPath = new URL('.env', root);
const markerPath = new URL('.local/circle-entity-registration.json', root);
const recoveryPath = new URL('.local/circle-recovery/', root);

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--register') {
    console.log('Usage: node scripts/register-circle-entity.mjs --register');
    console.log('Requires a fresh TEST Circle API key in the root .env. Refuses to overwrite an existing entity secret.');
    return;
  }
  const source = await readFile(envPath, 'utf8');
  const env = parseEnv(source);
  const apiKey = env.CIRCLE_API_KEY?.trim();
  if (!apiKey?.startsWith('TEST_API_KEY:')) throw new Error('Set a fresh test API key as CIRCLE_API_KEY in C:/UBC_Hack/.env first.');
  if (env.CIRCLE_ENTITY_SECRET?.trim()) throw new Error('CIRCLE_ENTITY_SECRET already exists. Reuse the existing registered secret; this helper will not overwrite or rotate it.');
  if (env.CIRCLE_WALLET_SET_ID?.trim() || env.CIRCLE_TREASURY_WALLET_ID?.trim()) {
    throw new Error('Existing Circle wallet IDs are configured. Locate their registered entity secret before creating a new one.');
  }
  await mkdir(new URL('.local/', root), { recursive: true });
  await mkdir(recoveryPath, { recursive: true });
  // Exclusive marker prevents concurrent or accidental repeat registration. Circle registration is not idempotent.
  await writeFile(markerPath, JSON.stringify({ status: 'preparing', at: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
  const entitySecret = randomBytes(32).toString('hex');
  const line = `CIRCLE_ENTITY_SECRET=${entitySecret}`;
  const updated = /^(?:export\s+)?CIRCLE_ENTITY_SECRET\s*=.*$/m.test(source)
    ? source.replace(/^(?:export\s+)?CIRCLE_ENTITY_SECRET\s*=.*$/m, line) : `${source.trimEnd()}\n${line}\n`;
  // Save before the remote request so an ambiguous network response cannot lose the signing secret.
  await writeFile(envPath, updated, { mode: 0o600 });
  await writeFile(markerPath, JSON.stringify({ status: 'registration_pending', at: new Date().toISOString() }, null, 2));
  let response;
  try { response = await registerEntitySecretCiphertext({ apiKey, entitySecret,
    recoveryFileDownloadPath: fileURLToPath(recoveryPath) }); }
  catch {
    throw new Error('Registration did not return success. The generated secret remains saved in .env. Check Circle Console before retrying; do not regenerate it or remove the registration marker blindly.');
  }
  if (!response.data?.recoveryFile) throw new Error('Registration returned without a recovery file. Keep the saved secret and check Circle Console. Do not repeat registration.');
  const recoveryFile = new URL(`recovery-${Date.now()}.dat`, recoveryPath);
  await writeFile(recoveryFile, response.data.recoveryFile, { flag: 'wx', mode: 0o600 });
  await writeFile(markerPath, JSON.stringify({ status: 'registered', at: new Date().toISOString(), recoveryFile: recoveryFile.pathname }, null, 2));
  console.log('Entity secret registered with Circle and saved in the ignored root .env.');
  console.log('Recovery file saved under C:/UBC_Hack/.local/circle-recovery/. Back it up separately in secure storage.');
  console.log('Next: create or locate the wallet set and treasury, then confirm the faucet destination.');
}

main().catch(error => {
  // Only our fixed operational messages are printed; SDK/filesystem exception objects can contain sensitive data.
  const safe = error instanceof Error && [
    'Set a fresh test API key', 'CIRCLE_ENTITY_SECRET already exists.', 'Existing Circle wallet IDs',
    'Registration did not return success.', 'Registration returned without a recovery file.',
  ].some(prefix => error.message.startsWith(prefix));
  console.error(safe ? error.message : 'Setup stopped. Check .env and the local registration marker; no secret values were printed.');
  process.exitCode = 1;
});
