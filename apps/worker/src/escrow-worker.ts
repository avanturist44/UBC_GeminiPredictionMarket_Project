import { createGeminiPublicClient } from '@thesis/core';
import { createDb } from '@thesis/db';
import { runMigrations } from '@thesis/db/migrate';
import { createArcGateway, runEscrowCycle } from '@thesis/services';
import { loadEnv } from './env';
import { createLocalWorkerControl } from './local-control';
const env = loadEnv();
await runMigrations(env.DATABASE_URL);
const { db, close } = createDb(env.DATABASE_URL);
const gateway = env.ESCROW_ENABLED ? createArcGateway() : undefined;
const client = createGeminiPublicClient({ baseUrl: env.GEMINI_PUBLIC_BASE, logger: { warn() {} } });
let stopping = false, wake: (() => void) | undefined;
const stop = () => { stopping = true; wake?.(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
const startedAt = new Date().toISOString(); let lastCycleAt = startedAt;
const control = createLocalWorkerControl({ healthFile: process.env.WORKER_HEALTH_FILE, stopFile: process.env.WORKER_STOP_FILE,
  requestStop: stop, onError() {}, health: () => ({ pid: process.pid, startedAt, lastCycleAt, stopping,
    indexAgeMs: null, volatilityReturnCount: 0, streamConnected: true }) });
console.log(JSON.stringify({ at: startedAt, message: 'Arc testnet escrow worker started', enabled: !!gateway }));
try {
  while (!stopping) {
    try {
      if (gateway) { const result = await runEscrowCycle(db, gateway, client);
        if (result.actions || result.wallets || result.copiesSettled || result.errors.length) console.log(JSON.stringify({ at: new Date().toISOString(), ...result })); }
    } catch { console.error(JSON.stringify({ at: new Date().toISOString(), errorCode: 'escrow_cycle_unavailable' })); }
    lastCycleAt = new Date().toISOString();
    if (!stopping) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); wake = () => { clearTimeout(timer); resolve(); }; });
  }
} finally { control.close(); await close(); }
