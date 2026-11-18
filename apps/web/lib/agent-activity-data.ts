import 'server-only';
import { agentRuns, markets, desc, eq, sql } from '@thesis/db';
import { getDb } from './db';
import { toActivity, type ActivityResponse } from './agent-activity';
import type { Loaded } from './market-data';

export async function loadAgentActivity(): Promise<Loaded<ActivityResponse>> {
  const db = getDb();
  if (!db) return { ok: false, status: 503, error: { code: 'not_configured', message: 'Connect a database to see recorded agent activity.' } };
  try {
    // Bound each agent separately so frequent BTC skips cannot hide news research.
    const batches = await Promise.all(['momentum', 'news'].map(agent => db.select({
      id: agentRuns.id, agentKey: agentRuns.agentKey, decision: agentRuns.decision,
      reason: agentRuns.reason, signal: agentRuns.signal, createdAt: agentRuns.createdAt,
      market: markets.title,
    }).from(agentRuns).leftJoin(markets, eq(agentRuns.marketId, markets.id))
      .where(eq(agentRuns.agentKey, agent)).orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(20)));
    // Retain fills/settlements even when frequent skips fill the recent window.
    const milestones = await db.select({ id: agentRuns.id, agentKey: agentRuns.agentKey,
      decision: agentRuns.decision, reason: agentRuns.reason, signal: agentRuns.signal,
      createdAt: agentRuns.createdAt, market: markets.title,
    }).from(agentRuns).leftJoin(markets, eq(agentRuns.marketId, markets.id))
      .where(sql`${agentRuns.agentKey} = 'momentum' and (${agentRuns.decision} = 'trade' or ${agentRuns.reason} = 'paper settlement')`)
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(6);
    const unique = new Map([...batches.flat(), ...milestones].map(row => [row.id, row]));
    return { ok: true, data: { asOf: new Date().toISOString(), events: [...unique.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(toActivity) } };
  } catch {
    return { ok: false, status: 503, error: { code: 'db_error', message: 'Agent activity is temporarily unavailable. Retrying shortly.' } };
  }
}
