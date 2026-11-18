/** Public decision records: deliberately excludes raw signals, errors and model internals. */
export type ActivityRow = {
  id: string; agentKey: string; decision: string; reason: string | null;
  signal: unknown; createdAt: Date; market: string | null;
};
export type Activity = {
  id: string; agent: string; at: string; market: string | null;
  stage: string; summary: string; mode: string;
  checks: { label: string; value: string }[];
  sources: { url: string; claim: string }[];
};
export type ActivityResponse = { asOf: string; events: Activity[] };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';
function publicUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
      !url.hostname.includes('.') || /(^|\.)(localhost|local|internal)$/.test(url.hostname) ||
      /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return null;
    url.hash = ''; return url.href;
  } catch { return null; }
}
export function toActivity(row: ActivityRow): Activity {
  const signal = object(row.signal);
  const input = object(signal.input);
  const health = object(signal.health);
  const forecast = object(signal.forecast);
  const quote = object(input.quote ?? signal.quote);
  const phase = text(signal.phase, 30);
  const checks: Activity['checks'] = [];
  const add = (label: string, value: unknown, format: (n: number) => string) => {
    const n = number(value);
    if (n !== null) checks.push({ label, value: format(n) });
  };
  add('BTC index', input.indexPrice ?? health.indexPrice, n => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
  add('One-minute returns', input.volatilityReturnCount ?? health.volatilityReturnCount, n => `${n} / 30`);
  add('YES bid', quote.bid, n => `${(n * 100).toFixed(1)}¢`);
  add('YES ask', quote.ask, n => `${(n * 100).toFixed(1)}¢`);
  add('Available size', signal.availableQuantity, n => `${n} shares`);
  add('Estimated YES probability', signal.probabilityYes ?? forecast.probability_yes, n => `${(n * 100).toFixed(1)}%`);
  add('Estimated edge', signal.edge, n => `${(n * 100).toFixed(1)}%`);
  const isPaper = signal.mode === 'paper';
  let stage = 'Skipped';
  let summary = 'The agent recorded a skip. No entry was placed.';
  if (row.reason === 'paper settlement') {
    stage = 'Settled';
    const outcome = signal.outcome === 'yes' ? 'YES' : signal.outcome === 'no' ? 'NO' : signal.outcome === 'void' ? 'VOID' : 'pending';
    summary = `Official Gemini outcome: ${outcome}. The paper position was settled.`;
  } else if (row.decision === 'trade' && isPaper) {
    stage = 'Paper entry';
    summary = `Simulated ${signal.side === 'no' ? 'NO' : 'YES'} entry after executable quote and risk checks. No real order was submitted.`;
  } else if (phase === 'research') {
    stage = 'Researching'; summary = 'Web research was requested. Waiting for a recorded forecast and sources.';
  } else if (phase === 'failed' || phase === 'cancelled' || row.reason?.includes('error')) {
    stage = 'Interrupted'; summary = 'This run did not complete. No entry was placed.';
  } else if (row.reason?.includes('not configured')) {
    stage = 'Not configured'; summary = 'The news research provider is not configured for this run.';
  } else if (row.reason?.includes('warmup') || row.reason?.includes('30 one-minute') || row.reason?.includes('volatility')) {
    stage = 'Warming up'; summary = 'Collecting 30 completed one-minute returns before considering an entry.';
  } else if (!isPaper && (signal.decision === 'trade' || signal.decision === 'candidate' || row.reason?.startsWith('log only: hypothetical'))) {
    stage = 'Hypothetical signal'; summary = 'A candidate passed the strategy checks. This log-only agent did not execute a trade.';
  } else {
    // Only disclose known operational reasons, never arbitrary error/exception messages.
    const reasons: Record<string, string> = {
      'market not open': 'The contract is not open for entries.',
      'position already exists': 'A position already exists for this contract; duplicate entry prevented.',
      'no unexpired tracked BTC 15-minute contracts': 'Waiting for an unexpired tracked BTC 15-minute contract.',
      'daily loss stop': 'The daily loss limit halted new entries.',
      'agent halted': 'The agent is halted. No new entries are permitted.',
      'trading disabled': 'Trading is disabled. No entry was placed.',
      'daily trade limit': 'The daily trade limit has been reached.',
      'open exposure limit': 'Open positions have reached the exposure limit.',
      'paper bankroll exhausted': 'No paper bankroll remains for another entry.',
      'price band or executable size limit': 'The quote price or executable size does not meet the entry limits.',
      'outside entry window': 'Waiting for the permitted entry window.',
    };
    if (row.reason && reasons[row.reason]) summary = reasons[row.reason]!;
    else if (row.reason?.includes('stale')) summary = 'Market input is stale. Waiting for a fresh executable quote.';
    else if (row.reason?.includes('edge')) summary = 'The estimated edge does not meet the entry threshold.';
    else if (row.reason?.includes('spread')) summary = 'The bid–ask spread exceeds the strategy limit.';
    else if (row.reason?.includes('entry window')) summary = 'Waiting for the permitted entry window.';
  }
  const retrieved = new Set((Array.isArray(signal.retrievedSources) ? signal.retrievedSources : [])
    .map(source => publicUrl(object(source).url)).filter(Boolean));
  const sources: Activity['sources'] = [];
  if (phase === 'completed' && retrieved.size) {
    for (const evidence of (Array.isArray(forecast.evidence) ? forecast.evidence : []).slice(0, 8)) {
      const item = object(evidence); const url = publicUrl(item.url);
      if (url && retrieved.has(url)) sources.push({ url, claim: text(item.claim, 500) });
    }
    if (sources.length && typeof forecast.body === 'string') summary += ` ${text(forecast.body, 1200)}`;
  }
  return { id: row.id, agent: row.agentKey, at: row.createdAt.toISOString(),
    market: row.market, stage, summary, mode: isPaper ? 'Paper trading' : 'Log only', checks, sources };
}

