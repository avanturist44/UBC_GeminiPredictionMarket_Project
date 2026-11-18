/** Explicit one-shot research-only run. Never submits orders or inserts paper trades. */
import { createGeminiPublicClient } from '@thesis/core';
import { agentRuns, createDb, desc, eq } from '@thesis/db';
import { loadEnv } from './env';
import { createNewsObserver } from './news-observer';

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
try {
  const observer = createNewsObserver(db, createGeminiPublicClient({ baseUrl: env.GEMINI_PUBLIC_BASE }), { enabled: () => true });
  const runs = await observer.run();
  const [last] = await db.select().from(agentRuns).where(eq(agentRuns.agentKey, 'news')).orderBy(desc(agentRuns.createdAt)).limit(1);
  console.log(JSON.stringify({ mode: 'log-only', newRuns: runs, providerConfigured: false,
    latestRun: last ? { id: last.id, decision: last.decision, reason: last.reason, at: last.createdAt } : null,
    note: 'Provider not selected yet; Grok is preferred for the later integration. No forecasts or trades were fabricated.' }));
} catch (error) {
  console.log(JSON.stringify({ check: 'news observer', ok: false, errorType: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
} finally { await close(); }
