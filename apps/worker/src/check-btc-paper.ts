/** Read-only Phase 2 progress report for the configured paper database. */
import { agentRuns, agentState, and, authors, createDb, desc, eq, markets, trades } from '@thesis/db';
import { loadEnv } from './env';
import { units } from './paper';

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
try {
  const positions = await db.select({ trade: trades, market: markets }).from(trades)
    .innerJoin(authors, eq(trades.authorId, authors.id)).innerJoin(markets, eq(trades.marketId, markets.id))
    .where(and(eq(authors.agentKey, 'momentum'), eq(trades.mode, 'paper')));
  const runs = await db.select().from(agentRuns).where(eq(agentRuns.agentKey, 'momentum')).orderBy(desc(agentRuns.createdAt));
  const states = await db.select().from(agentState).where(eq(agentState.agentKey, 'momentum')).orderBy(desc(agentState.day)).limit(1);
  const fills = positions.filter(({ trade, market }) => /^GEMI-BTC15M\d+-UP$/.test(market.instrumentSymbol) &&
    ['filled', 'settled'].includes(trade.status) && trade.isAuthorPosition && trade.locked &&
    trade.idempotencyKey === `paper:momentum:${market.id}`);
  const logged = fills.filter(({ trade }) => runs.some((run) => run.marketId === trade.marketId && run.decision === 'trade' && run.signal?.mode === 'paper'));
  const settled = fills.filter(({ trade }) => trade.status === 'settled');
  const correct = settled.filter(({ trade, market }) => {
    if (trade.payoutUsd === null) return false;
    if (market.status === 'invalid') return units(trade.payoutUsd) === units(trade.costUsd);
    if (!market.resolutionSide) return false;
    return units(trade.payoutUsd) === (trade.side === market.resolutionSide ? units(trade.quantity) : 0n);
  });
  const invalidSettlements = settled.length - correct.length;
  const officialSettlements = correct.filter(({ market }) => market.status === 'settled' && market.resolutionSide !== null);
  const uniqueLoggedContracts = new Set(logged.map(({ trade }) => trade.marketId)).size;
  const criteriaMet = uniqueLoggedContracts >= 3 && officialSettlements.length >= 1 && invalidSettlements === 0;
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    latestDecisionAgeSeconds: runs[0] ? Math.round((Date.now() - runs[0].createdAt.getTime()) / 1000) : null,
    databaseTarget: ['127.0.0.1', 'localhost'].includes(new URL(env.DATABASE_URL).hostname) ? 'local' : 'remote',
    paperFills: fills.length, loggedContracts: uniqueLoggedContracts,
    correctlySettled: correct.length, correctOfficialSettlements: officialSettlements.length,
    invalidSettlements, livePaperCriteriaMet: criteriaMet,
    latestDecision: runs[0] ? { at: runs[0].createdAt, decision: runs[0].decision, reason: runs[0].reason,
      health: runs[0].signal?.health ?? null } : null,
    state: states[0] ?? null,
    note: 'Database evidence only. The daily-loss-stop test must also pass. Use a database populated by live worker input, not synthetic test signals.',
  }));
  if (!criteriaMet) process.exitCode = 2;
} catch (error) {
  // Connection errors can contain connection details; output only the type/code.
  console.log(JSON.stringify({ check: 'paper progress', ok: false,
    errorType: error instanceof Error ? error.name : 'unknown',
    code: typeof error === 'object' && error && 'code' in error ? error.code : null }));
  process.exitCode = 1;
} finally { await close(); }
