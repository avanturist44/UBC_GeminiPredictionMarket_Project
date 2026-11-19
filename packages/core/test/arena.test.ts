import { describe, expect, it } from 'vitest';
import { ARENA_ROSTER, ARENA_STRATEGY, arenaEntrant } from '../src/arena';

describe('the arena roster', () => {
  it('lists five entrants in the validated colour order, each its own agent', () => {
    expect(ARENA_ROSTER.map((e) => e.id)).toEqual(['gemini', 'claude', 'gpt', 'grok', 'deepseek']);
    expect(new Set(ARENA_ROSTER.map((e) => e.agentKey)).size).toBe(5);
    for (const e of ARENA_ROSTER) expect(e.agentKey).toBe(`arena-${e.id}`);
    expect(arenaEntrant('arena-claude')?.provider).toBe('anthropic');
    expect(arenaEntrant('news')).toBeUndefined();
  });

  it('shares one strategy sentence', () => {
    expect(ARENA_STRATEGY).toMatch(/10 points/);
  });
});
