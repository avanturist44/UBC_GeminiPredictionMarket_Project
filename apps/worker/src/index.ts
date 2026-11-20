import { DEFAULT_TRACKED_RULES, arcRpcUrls, createGeminiPublicClient, streamSymbolKey } from '@thesis/core';
import { createDb, listLiveTrackedMarkets } from '@thesis/db';
import { runMigrations } from '@thesis/db/migrate';
import type { Address, Hex } from 'viem';
import { runFadeCycle, runNewsCycle } from './agents';
import { runArenaCycle } from './arena';
import { createArenaContenders } from './arena-contenders';
import { createEscrowChain } from './chain';
import { createCircleWallets } from './circle';
import { loadEnv } from './env';
import { createWorkerLlm } from './llm';
import { createSpendGuard } from './llm/spend-guard';
import { createOnchain, type Onchain } from './onchain';
import { createQuoteRecorder } from './quotes';
import { runRecorderCycle, type Logger } from './recorder';
import { runResolverCycle } from './resolver';
import { createPriceStream } from './stream';
import { createThesisPipeline, type BookQuote } from './thesis-pipeline';

/**
 * The always-on worker. It runs:
 * - the price recorder: a REST poll every 30 seconds and a WebSocket stream of live quotes;
 * - the thesis pipeline: audits every waiting thesis, fills its author's position, publishes;
 * - the resolver: when Gemini reports a result, marks theses right or wrong and pays positions;
 * - the model arena: one trading agent per AI model whose key is set, all looking at the same market;
 * - the `news` and `fade` agents, if switched on, when a language model is configured.
 * The on-chain registrar and tip settlement are added once the escrow is deployed.
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

/**
 * The daily dollar cap over every model call this worker makes, whichever model and whatever for.
 * There is one, and every Llm built here is given it.
 */
const spendGuard = createSpendGuard({ db, dailyCapUsd: env.LLM_DAILY_USD_CAP, logger });
const llmSettings = {
  provider: env.LLM_PROVIDER ?? (env.LLM_API_KEY ? ('anthropic' as const) : ('none' as const)),
  apiKey: env.LLM_API_KEY,
  effort: env.LLM_EFFORT,
  dailyTokenCap: env.LLM_DAILY_TOKEN_CAP,
  /** Arena models have caps of their own and never spend the auditor's and agents' budget. */
  excludePrefix: 'arena:',
};
/** The auditor's model. */
const llm = createWorkerLlm(db, { ...llmSettings, model: env.LLM_MODEL }, logger, spendGuard);
/** The agents' model: cheaper, because every look reads several web pages. Same daily caps. */
const agentLlm = createWorkerLlm(db, { ...llmSettings, model: env.LLM_AGENT_MODEL }, logger, spendGuard);
const enabledAgents = new Set(
  env.ENABLED_AGENTS.split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name === 'arena' || name === 'news' || name === 'fade'),
);
/**
 * The arena's models: each with its own daily token cap, apart from the auditor's, and all under
 * the same dollar guard as every other model call. A model without its key is left out.
 */
const arena = enabledAgents.has('arena') ? createArenaContenders(env, db, logger, spendGuard) : [];
const agents = [
  ...(agentLlm ? [...enabledAgents].filter((name) => name !== 'arena') : []),
  ...(arena.length > 0 ? ['arena'] : []),
];
const tradingEnabled = () => env.TRADING_ENABLED;

// The on-chain jobs run only when the contract, both keys and Circle are all configured.
let onchain: Onchain | null = null;
if (
  env.ESCROW_ADDRESS &&
  env.REGISTRAR_KEY &&
  env.RESOLVER_KEY &&
  env.CIRCLE_API_KEY &&
  env.CIRCLE_ENTITY_SECRET &&
  env.CIRCLE_WALLET_SET_ID &&
  env.CIRCLE_TREASURY_WALLET_ID
) {
  onchain = createOnchain({
    db,
    logger,
    welcomeUsdc: env.WELCOME_USDC,
    chain: createEscrowChain({
      rpcUrls: arcRpcUrls(env.ARC_RPC_URL),
      chainId: env.ARC_CHAIN_ID,
      escrowAddress: env.ESCROW_ADDRESS as Address,
      usdcAddress: env.USDC_ADDRESS as Address,
      registrarKey: env.REGISTRAR_KEY as Hex,
      resolverKey: env.RESOLVER_KEY as Hex,
    }),
    circle: createCircleWallets({
      apiKey: env.CIRCLE_API_KEY,
      entitySecret: env.CIRCLE_ENTITY_SECRET,
      walletSetId: env.CIRCLE_WALLET_SET_ID,
      treasuryWalletId: env.CIRCLE_TREASURY_WALLET_ID,
      usdcAddress: env.USDC_ADDRESS,
    }),
  });
}

const pipeline = createThesisPipeline({
  db,
  llm,
  book: (symbol) => books.get(streamSymbolKey(symbol)),
  tradingEnabled,
  register: onchain?.register,
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
  jobs: ['price-recorder', 'thesis-pipeline', 'resolver', ...agents, ...(onchain ? ['tips', 'tip-settlement'] : [])],
  agentModel: agents.some((name) => name !== 'arena') ? env.LLM_AGENT_MODEL : 'no news or fade agent running',
  arena:
    arena.length > 0
      ? {
          models: arena.map(({ entrant }) => `${entrant.id}: ${entrant.model}`),
          intervalMinutes: env.ARENA_INTERVAL_MINUTES,
          dailyTokenCapPerModel: env.ARENA_DAILY_TOKEN_CAP_PER_MODEL,
        }
      : enabledAgents.has('arena')
        ? 'not running: no arena model has its API key set'
        : 'not enabled (ENABLED_AGENTS)',
  escrow: env.ESCROW_ADDRESS ?? 'not configured: theses are published without an on-chain record, and tips are off',
  // Hosts only: a dedicated endpoint's path holds its access token.
  arcRpc: arcRpcUrls(env.ARC_RPC_URL).map((url) => new URL(url).host),
  intervalMs: env.RECORDER_INTERVAL_MS,
  stream: env.GEMINI_WS_URL,
  auditor: llm ? llm.model : 'phrase screen only (no language model configured)',
  llmDailyUsdCap: env.LLM_DAILY_USD_CAP,
  tradingEnabled: env.TRADING_ENABLED,
  rules: DEFAULT_TRACKED_RULES.map((rule) => rule.key),
});

every('resolver', 30_000, 20_000, async () => {
  // Three markets a cycle: the recorder shares the same request budget with Gemini.
  const summary = await runResolverCycle({ db, client, logger, batch: 3 });
  if (summary.resolved > 0) log('info', 'resolver', { ...summary });
});
every('thesis pipeline', 3000, 3000, async () => {
  const summary = await pipeline.runCycle();
  if (Object.values(summary).some((count) => count > 0)) log('info', 'thesis pipeline', { ...summary });
});
if (onchain) {
  const jobs = onchain;
  every('tips', 5000, 5000, async () => {
    const summary = await jobs.runTipCycle();
    if (summary.escrowed > 0 || summary.failed > 0) log('info', 'tips', { ...summary });
  });
  every('tip settlement', 30_000, 25_000, async () => {
    const summary = await jobs.runSettlementCycle();
    if (summary.paid > 0 || summary.refunded > 0) log('info', 'tip settlement', { ...summary });
  });
}
if (arena.length > 0) {
  // Every model on the same market with the same prompt, then each trades on its own.
  every('arena', env.ARENA_INTERVAL_MINUTES * 60_000, 60_000, async () => {
    log('info', 'arena', { ...(await runArenaCycle({ db, contenders: arena, tradingEnabled, logger })) });
  });
}
if (agentLlm) {
  const agentDeps = { db, llm: agentLlm, tradingEnabled, logger };
  if (enabledAgents.has('news')) {
    every('news agent', env.NEWS_INTERVAL_MINUTES * 60_000, 60_000, async () => {
      log('info', 'news agent', { ...(await runNewsCycle(agentDeps)) });
    });
  }
  // Off by default: the build plan lists `fade` among the first things to cut.
  if (enabledAgents.has('fade')) {
    every('fade agent', 5 * 60_000, 90_000, async () => {
      log('info', 'fade agent', { ...(await runFadeCycle(agentDeps)) });
    });
  }
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
