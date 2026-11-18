import { describe, it, expect } from 'vitest';
import { toActivity, type ActivityRow } from '../lib/agent-activity';
const row = (patch: Partial<ActivityRow> = {}): ActivityRow => ({ id: 'run', agentKey: 'momentum',
  decision: 'skip', reason: null, signal: null, createdAt: new Date('2026-11-18T22:00:00Z'), market: null, ...patch });
describe('public agent decision activity', () => {
  it('never exposes arbitrary signal fields, private reasoning or raw errors', () => {
    const activity = toActivity(row({ reason: 'database password=secret', signal: {
      reasoning: 'private chain', encrypted_content: 'secret', apiKey: 'secret', input: { password: 'secret' },
    } }));
    expect(JSON.stringify(activity)).not.toMatch(/secret|private chain|password|encrypted_content/);
    expect(activity.stage).toBe('Skipped');
  });
  it('does not mistake a blocked paper candidate for a fill', () => {
    const activity = toActivity(row({ reason: 'daily loss stop', signal: { mode: 'paper', decision: 'trade', side: 'yes', edge: .1 } }));
    expect(activity.stage).toBe('Skipped');
    expect(activity.summary).toContain('daily loss limit');
  });
  it('distinguishes hypothetical, executed paper and official settlement records', () => {
    expect(toActivity(row({ signal: { mode: 'log-only', decision: 'trade' } })).stage).toBe('Hypothetical signal');
    expect(toActivity(row({ decision: 'trade', signal: { mode: 'paper', side: 'no' } })).summary).toContain('NO entry');
    expect(toActivity(row({ reason: 'paper settlement', signal: { mode: 'paper', outcome: 'no' } })).summary).toContain('outcome: NO');
  });
  it('shows warmup progress and excludes non-finite inputs', () => {
    const activity = toActivity(row({ reason: 'warming up volatility (8/30 returns)', signal: {
      input: { volatilityReturnCount: 8, indexPrice: NaN, quote: { ask: .6, bid: .58 } },
    } }));
    expect(activity.stage).toBe('Warming up');
    expect(activity.checks).toContainEqual({ label: 'One-minute returns', value: '8 / 30' });
    expect(activity.checks.find(c => c.label === 'BTC index')).toBeUndefined();
  });
  it('only publishes evidence matching retrieved public HTTPS URLs', () => {
    const activity = toActivity(row({ agentKey: 'news', signal: { phase: 'completed',
      retrievedSources: [{ url: 'https://example.com/report' }, { url: 'https://127.0.0.1/private' }],
      forecast: { body: 'Recorded evidence summary.', evidence: [
        { url: 'https://example.com/report', claim: 'Retrieved report' },
        { url: 'https://invented.example/article', claim: 'Ungrounded' },
        { url: 'javascript:alert(1)', claim: 'Unsafe' },
        { url: 'https://127.0.0.1/private', claim: 'Private' },
      ] },
    } }));
    expect(activity.sources).toEqual([{ url: 'https://example.com/report', claim: 'Retrieved report' }]);
    expect(activity.summary).toContain('Recorded evidence summary');
  });
  it('does not expose an unsupported forecast body without retrieved evidence', () => {
    const activity = toActivity(row({ signal: { phase: 'completed', forecast: { body: 'unsupported' } } }));
    expect(activity.summary).not.toContain('unsupported');
  });
  it('handles malformed JSON records and news progress without inventing trades', () => {
    expect(toActivity(row({ signal: ['unexpected'] })).checks).toEqual([]);
    expect(toActivity(row({ agentKey: 'news', signal: { phase: 'research' } })).stage).toBe('Researching');
    expect(toActivity(row({ signal: { phase: 'failed' } })).stage).toBe('Interrupted');
  });
});
