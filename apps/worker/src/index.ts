import { DEFAULT_TRACKED_RULES, createGeminiPublicClient } from '@thesis/core';
import { createDb, listLiveTrackedMarkets } from '@thesis/db';
import { runMigrations } from '@thesis/db/migrate';
import { loadEnv } from './env';
import { BTC_INDEX_STREAM, createMomentumObserver } from './momentum-observer';
import { createQuoteRecorder } from './quotes';
import { runRecorderCycle, type Logger } from './recorder';
import { createPriceStream } from './stream';
import { createPaperAdapter, recordMomentumError } from './paper';
import { createNewsObserver } from './news-observer';
import { createXaiResearchProvider } from './xai-research';
import { createLocalWorkerControl } from './local-control';

const log = (level: string, message: string, extra: object = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, message, ...extra }));
const logger: Logger = {
  info: (message) => log('info', message),
  warn: (message) => log('warn', message),
  error: (message) => log('error', message),
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const env = loadEnv();
await runMigrations(env.DATABASE_URL);
const { db, close } = createDb(env.DATABASE_URL);
const client = createGeminiPublicClient({ baseUrl: env.GEMINI_PUBLIC_BASE, logger });

const quotes = createQuoteRecorder({ db, logger });
const paper = createPaperAdapter(db, client, { enabled: () => env.TRADING_ENABLED });
const momentum = createMomentumObserver(db, { adapter: env.BTC_BOT_MODE === 'paper' ? paper : undefined });
const newsAbort = new AbortController();
const researchProvider = env.LLM_PROVIDER === 'xai' && env.XAI_API_KEY ?
  createXaiResearchProvider({ apiKey: env.XAI_API_KEY, model: env.LLM_MODEL }) : undefined;
const news = createNewsObserver(db, client, { enabled: () => env.NEWS_AGENT_ENABLED, signal: newsAbort.signal, provider: researchProvider });
let newsTask: Promise<unknown> | undefined;
const stream = createPriceStream({
  url: env.GEMINI_WS_URL,
  extraStreams: [BTC_INDEX_STREAM],
  onTicker(ticker) {
    quotes.handle(ticker);
    momentum.handleTicker(ticker);
    news.handleTicker(ticker);
  },
  onOther: momentum.handleOther,
  logger,
});

/** Points the stream at the contracts that are tracked and have not expired. */
async function syncStream(): Promise<void> {
  try {
    const live = await listLiveTrackedMarkets(db, new Date());
    quotes.setMarkets(live);
    stream.setSymbols(live.map((market) => market.instrumentSymbol));
  } catch (error) {
    // The stream keeps its current subscriptions until the next cycle.
    log('error', 'stream sync failed', { error: errorText(error) });
  }
}

let stopping = false;
let wake: (() => void) | undefined;
const requestStop = () => {
    if (stopping) return;
    stopping = true;
    newsAbort.abort();
    wake?.();
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, requestStop);
}
const startedAt = new Date().toISOString();
let lastCycleAt = startedAt;
const localControl = createLocalWorkerControl({
  healthFile: process.env.WORKER_HEALTH_FILE, stopFile: process.env.WORKER_STOP_FILE,
  requestStop, onError: () => logger.warn('local worker control file could not be updated'),
  health: () => ({ pid: process.pid, startedAt, lastCycleAt, stopping,
    indexAgeMs: momentum.status().indexAgeMs, volatilityReturnCount: momentum.status().volatilityReturnCount,
    streamConnected: stream.status().connected }),
});

log('info', 'worker started', {
  job: 'price-recorder',
  intervalMs: env.RECORDER_INTERVAL_MS,
  stream: env.GEMINI_WS_URL,
  rules: DEFAULT_TRACKED_RULES.map((rule) => rule.key),
});

// Contracts recorded by an earlier run can be streamed before the first poll finishes.
await syncStream();
stream.start();
const flushTimer = setInterval(() => {
  quotes.flush().catch((error) => log('error', 'stream flush failed', { error: errorText(error) }));
}, 1000);

while (!stopping) {
  const started = Date.now();
  try {
    const summary = await runRecorderCycle({ db, client, rules: DEFAULT_TRACKED_RULES, logger });
    log('info', 'recorder cycle', {
      ...summary,
      ms: Date.now() - started,
      stream: { ...stream.status(), points: quotes.stats().written },
    });
  } catch (error) {
    // A cycle-level failure, such as the database being unreachable. Keep looping.
    log('error', 'recorder cycle failed', { error: errorText(error) });
  }
  // The poll is what finds new contracts and notices expired ones.
  await syncStream();
  if (!stopping) {
    try {
      const settled = await paper.settle();
      const runs = await momentum.run();
      log('info', 'momentum cycle', { runs, settled, mode: env.BTC_BOT_MODE, health: momentum.status() });
    } catch (error) {
      log('error', 'momentum observation failed', { error: errorText(error) });
      await recordMomentumError(db, error).catch((failure) =>
        log('error', 'momentum error persistence failed', { error: errorText(failure) }));
    }
    // Research may take tens of seconds. It must not delay BTC decisions or recorder cycles.
    if (!newsTask && env.NEWS_AGENT_ENABLED) {
      newsTask = news.run().then((runs) => {
        if (runs) log('info', 'news observation cycle', { runs, mode: 'log-only' });
      }).catch((error) => log('error', 'news observation failed', { error: errorText(error) }))
        .finally(() => { newsTask = undefined; });
    }
  }
  lastCycleAt = new Date().toISOString();
  // A signal that arrived during the cycle: stop now instead of sleeping first.
  if (stopping) break;
  const wait = Math.max(0, env.RECORDER_INTERVAL_MS - (Date.now() - started));
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, wait);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  wake = undefined;
}

clearInterval(flushTimer);
localControl.close();
stream.stop();
await newsTask;
await close();
log('info', 'worker stopped');
