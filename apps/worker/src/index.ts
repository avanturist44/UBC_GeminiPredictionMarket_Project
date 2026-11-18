import { DEFAULT_TRACKED_RULES, createGeminiPublicClient, streamSymbolKey } from '@thesis/core';
import { createDb, listLiveTrackedMarkets } from '@thesis/db';
import { runMigrations } from '@thesis/db/migrate';
import { runFadeCycle, runNewsCycle } from './agents';
import { loadEnv } from './env';
import { createWorkerLlm } from './llm';
import { createQuoteRecorder } from './quotes';
import { runRecorderCycle, type Logger } from './recorder';
import { createPriceStream } from './stream';
import { createThesisPipeline, type BookQuote } from './thesis-pipeline';

/**
 * The always-on worker. It runs:
 * - the price recorder: a REST poll every 30 seconds and a WebSocket stream of live quotes;
 * - the thesis pipeline: audits every waiting thesis, fills its author's position, publishes;
 * - the `news` and `fade` agents, when a language model is configured.
 * The registrar and the resolver are added in later phases.
 */

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
/** The stream's live top of book per symbol, with sizes, for simulated fills. */
const books = new Map<string, BookQuote>();
const stream = createPriceStream({
  url: env.GEMINI_WS_URL,
  onTicker(ticker) {
    quotes.handle(ticker);
    books.set(ticker.symbolKey, {
      yesBid: ticker.bid,
      yesAsk: ticker.ask,
      bidSize: ticker.bidSize,
      askSize: ticker.askSize,
      at: Date.now(),
    });
  },
  logger,
});

const llm = createWorkerLlm(
  db,
  {
    provider: env.LLM_PROVIDER ?? (env.LLM_API_KEY ? 'anthropic' : 'none'),
    model: env.LLM_MODEL,
    apiKey: env.LLM_API_KEY,
    effort: env.LLM_EFFORT,
    dailyTokenCap: env.LLM_DAILY_TOKEN_CAP,
  },
  logger,
);
const tradingEnabled = () => env.TRADING_ENABLED;
const pipeline = createThesisPipeline({
  db,
  llm,
  book: (symbol) => books.get(streamSymbolKey(symbol)),
  tradingEnabled,
  logger,
});

/** Runs a job again and again, `everyMs` after it last finished, never two at once. */
const timers = new Set<ReturnType<typeof setTimeout>>();
function every(name: string, everyMs: number, firstMs: number, job: () => Promise<void>): void {
  const schedule = (wait: number) => {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (stopping) return;
      try {
        await job();
      } catch (error) {
        log('error', `${name} failed`, { error: errorText(error) });
      }
      if (!stopping) schedule(everyMs);
    }, wait);
    timers.add(timer);
  };
  schedule(firstMs);
}

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
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    wake?.();
  });
}

log('info', 'worker started', {
  jobs: ['price-recorder', 'thesis-pipeline', ...(llm ? ['news', 'fade'] : [])],
  intervalMs: env.RECORDER_INTERVAL_MS,
  stream: env.GEMINI_WS_URL,
  auditor: llm ? llm.model : 'phrase screen only (no language model configured)',
  tradingEnabled: env.TRADING_ENABLED,
  rules: DEFAULT_TRACKED_RULES.map((rule) => rule.key),
});

every('thesis pipeline', 3000, 3000, async () => {
  const summary = await pipeline.runCycle();
  if (Object.values(summary).some((count) => count > 0)) log('info', 'thesis pipeline', { ...summary });
});
if (llm) {
  const agentDeps = { db, llm, tradingEnabled, logger };
  every('news agent', 15 * 60_000, 60_000, async () => {
    log('info', 'news agent', { ...(await runNewsCycle(agentDeps)) });
  });
  every('fade agent', 5 * 60_000, 90_000, async () => {
    log('info', 'fade agent', { ...(await runFadeCycle(agentDeps)) });
  });
}

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
for (const timer of timers) clearTimeout(timer);
stream.stop();
await close();
log('info', 'worker stopped');
