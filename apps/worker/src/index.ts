import { DEFAULT_TRACKED_RULES, createGeminiPublicClient } from '@thesis/core';
import { createDb } from '@thesis/db';
import { runMigrations } from '@thesis/db/migrate';
import { loadEnv } from './env';
import { runRecorderCycle, type Logger } from './recorder';

/**
 * The always-on worker. Phase 0 runs one job, the price recorder.
 * Agents, the auditor, the registrar and the resolver are added in later phases.
 */

const log = (level: string, message: string, extra: object = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, message, ...extra }));
const logger: Logger = {
  info: (message) => log('info', message),
  warn: (message) => log('warn', message),
  error: (message) => log('error', message),
};

const env = loadEnv();
await runMigrations(env.DATABASE_URL);
const { db, close } = createDb(env.DATABASE_URL);
const client = createGeminiPublicClient({ baseUrl: env.GEMINI_PUBLIC_BASE, logger });

let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    wake?.();
  });
}

log('info', 'worker started', {
  job: 'price-recorder',
  intervalMs: env.RECORDER_INTERVAL_MS,
  rules: DEFAULT_TRACKED_RULES.map((rule) => rule.key),
});

while (!stopping) {
  const started = Date.now();
  try {
    const summary = await runRecorderCycle({ db, client, rules: DEFAULT_TRACKED_RULES, logger });
    log('info', 'recorder cycle', { ...summary, ms: Date.now() - started });
  } catch (error) {
    // A cycle-level failure, such as the database being unreachable. Keep looping.
    log('error', 'recorder cycle failed', { error: error instanceof Error ? error.message : String(error) });
  }
  const wait = Math.max(0, env.RECORDER_INTERVAL_MS - (Date.now() - started));
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, wait);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

await close();
log('info', 'worker stopped');
