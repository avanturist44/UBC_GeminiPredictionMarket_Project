/** Metered, one-shot live fact-check. Does not publish or place a trade. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createXaiAuditProvider, screenThesis } from '../packages/services/src/index';
process.loadEnvFile(new URL('../.env', import.meta.url));
if (!process.env.XAI_API_KEY) throw new Error('Configure XAI_API_KEY before live verification.');
const provider = createXaiAuditProvider({ apiKey: process.env.XAI_API_KEY, model: process.env.LLM_MODEL || 'grok-4.7' });
const falseClaim = await provider.audit({ headline: 'Auditor verification: a false factual claim',
  body: 'This is an automated auditor test. The Moon is made entirely of cheddar cheese. My forecast on the market is a subjective opinion.',
  evidence: [{ claim: 'Composition of the Moon', url: 'https://science.nasa.gov/moon/facts/' }],
  market: { title: 'Verification only; no trade', symbol: 'AUDIT-ONLY', expiryAt: null, yesBid: null, yesAsk: null, asOf: new Date().toISOString() } });
const insideInfo = screenThesis('Auditor verification: non-public knowledge', 'My friend at the company gave me inside information about the outcome.');
const result = { checkedAt: new Date().toISOString(), falseClaim, insideInfo, passed: falseClaim.verdict === 'flagged' &&
  falseClaim.claims.some(c => c.status === 'contradicted' || c.status === 'unsupported') && insideInfo?.verdict === 'blocked' };
await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
await writeFile(new URL('../.local/live-auditor-result.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!result.passed) process.exitCode = 2;
