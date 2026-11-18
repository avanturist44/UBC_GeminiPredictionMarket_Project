/** Explicit one-shot research-only run. Never submits orders or inserts paper trades. */
import { createGeminiPublicClient } from '@thesis/core';
import { agentRuns, and, createDb, desc, eq, gt, markets } from '@thesis/db';
import { loadEnv } from './env';
import { createNewsObserver } from './news-observer';
import { createXaiResearchProvider } from './xai-research';
import { newsMarketEligible, NewsForecastSchema } from './news';
import { createPriceStream, type PriceStream } from './stream';

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
let stream: PriceStream | undefined;
try {
  const provider = env.LLM_PROVIDER === 'xai' && env.XAI_API_KEY ?
    createXaiResearchProvider({ apiKey: env.XAI_API_KEY, model: env.LLM_MODEL }) : undefined;
  const observer = createNewsObserver(db, createGeminiPublicClient({ baseUrl: env.GEMINI_PUBLIC_BASE }),
    { enabled: () => true, provider, retryFailed: process.argv.includes('--retry-failed') });
  if (provider) {
    const candidates = (await db.select().from(markets).where(and(eq(markets.tracked, true), gt(markets.expiryAt, new Date()))))
      .filter((market) => newsMarketEligible(market, Date.now()));
    let received: () => void = () => {};
    const firstBook = new Promise<void>((resolve) => { received = resolve; });
    stream = createPriceStream({ url: env.GEMINI_WS_URL, logger: { info() {}, warn() {}, error() {} },
      onTicker(ticker) { observer.handleTicker(ticker); received(); } });
    stream.setSymbols(candidates.map((market) => market.instrumentSymbol));
    stream.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([firstBook, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
  }
  const runs = await observer.run();
  const [last] = await db.select().from(agentRuns).where(eq(agentRuns.agentKey, 'news')).orderBy(desc(agentRuns.createdAt)).limit(1);
  const forecast = NewsForecastSchema.safeParse(last?.signal?.forecast);
  console.log(JSON.stringify({ mode: 'log-only', newRuns: runs, providerConfigured: !!provider,
    latestRun: last ? { id: last.id, decision: last.decision, reason: last.reason, at: last.createdAt, error: last.error,
      provider: last.signal?.provider, model: last.signal?.model,
      forecast: forecast.success ? { headline: forecast.data.headline, probabilityYes: forecast.data.probability_yes,
        confidence: forecast.data.confidence, citedUrls: forecast.data.evidence.map((item) => item.url) } : null } : null,
    note: 'Research and hypothetical decisions only; no orders, paper trades, or published theses.' }));
  if (last?.error && runs) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ check: 'news observer', ok: false, errorType: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
} finally { stream?.stop(); await close(); }
