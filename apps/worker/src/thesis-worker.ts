/** Separate publication worker: independent of the continuously warmed BTC process. */
import { createGeminiPublicClient } from '@thesis/core';
import { createDb } from '@thesis/db';
import { runMigrations } from '@thesis/db/migrate';
import { createXaiAuditProvider, flagLegacyTheses, openPublicationQuote, processThesisJob, settleHumans } from '@thesis/services';
import { loadEnv } from './env';
import { createLocalWorkerControl } from './local-control';

const env = loadEnv();
await runMigrations(env.DATABASE_URL);
const { db, close } = createDb(env.DATABASE_URL);
const client = createGeminiPublicClient({ baseUrl: env.GEMINI_PUBLIC_BASE, logger: { warn() {} } });
const provider = env.LLM_PROVIDER === 'xai' && env.XAI_API_KEY ? createXaiAuditProvider({ apiKey: env.XAI_API_KEY, model: env.LLM_MODEL }) : undefined;
const abort = new AbortController();
let stopping = false;
let wake: (() => void) | undefined;
const requestStop = () => { stopping = true; abort.abort(); wake?.(); };
process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);
const startedAt = new Date().toISOString();
let lastCycleAt = startedAt;
const control = createLocalWorkerControl({ healthFile: process.env.WORKER_HEALTH_FILE,
  stopFile: process.env.WORKER_STOP_FILE, requestStop, onError() {},
  health: () => ({ pid: process.pid, startedAt, lastCycleAt, stopping,
    indexAgeMs: null, volatilityReturnCount: 0, streamConnected: true }),
});
console.log(JSON.stringify({ at: startedAt, message: 'thesis worker started', configured: !!provider,
  enabled: process.env.THESIS_AUDIT_ENABLED === 'true', mode: 'paper', hourlyAuditCap: 20 }));
try {
  while (!stopping) {
    try {
      await flagLegacyTheses(db);
      const result = await processThesisJob(db, { provider, signal: abort.signal,
        requireRegistration: env.ESCROW_ENABLED ? process.env.ESCROW_ADDRESS : undefined,
        enabled: () => process.env.THESIS_AUDIT_ENABLED === 'true' && env.TRADING_ENABLED && !stopping,
        quote: market => openPublicationQuote(client, market, env.GEMINI_WS_URL) });
      const settled = await settleHumans(db, client);
      if (result.processed || settled) console.log(JSON.stringify({ at: new Date().toISOString(), ...result, settled }));
    } catch { console.error(JSON.stringify({ at: new Date().toISOString(), errorCode: 'publication_cycle_unavailable' })); }
    lastCycleAt = new Date().toISOString();
    if (!stopping) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5000);
      wake = () => { clearTimeout(timer); resolve(); };
    });
  }
} finally { control.close(); await close(); }
