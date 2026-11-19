/** Configure local guest publishing without printing secrets or selecting the hosted database. */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const path = new URL('../.env', import.meta.url);
let env = await readFile(path, 'utf8');
process.loadEnvFile(path);
if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) throw new Error('Local database required.');
if (!(process.env.SESSION_SECRET?.length >= 32)) {
  const line = `SESSION_SECRET=${randomBytes(32).toString('hex')}`;
  env = /^SESSION_SECRET=.*$/m.test(env) ? env.replace(/^SESSION_SECRET=.*$/m, line) : `${env.trimEnd()}\n${line}\n`;
}
const line = 'THESIS_AUDIT_ENABLED=true';
env = /^THESIS_AUDIT_ENABLED=.*$/m.test(env) ? env.replace(/^THESIS_AUDIT_ENABLED=.*$/m, line) : `${env.trimEnd()}\n${line}\n`;
await writeFile(path, env);
console.log('Local guest signing configured; thesis audit enabled. No secret values printed.');
