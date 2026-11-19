import { readFile, writeFile } from 'node:fs/promises';
const path = new URL('../.env', import.meta.url);
process.loadEnvFile(path);
if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) throw new Error('Local verification database required.');
if (!process.env.ESCROW_ADDRESS || !process.env.ESCROW_CODE_HASH) throw new Error('Deploy and verify escrow first.');
const source = await readFile(path, 'utf8');
await writeFile(path, /^ESCROW_ENABLED=.*$/m.test(source) ? source.replace(/^ESCROW_ENABLED=.*$/m, 'ESCROW_ENABLED=true') : `${source.trimEnd()}\nESCROW_ENABLED=true\n`);
console.log('Enabled Arc testnet escrow for the local application.');
