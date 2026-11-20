/**
 * The arena's entrants: one AI model per trading agent, all on the same strategy. The worker
 * runs one agent per entry and the web page draws one line per entry, so both read this
 * list. Plain data with no Node-only imports, so the browser entry point can export it.
 */

export type ModelId = 'gemini' | 'claude' | 'gpt' | 'grok' | 'deepseek';

export type ArenaProvider = 'anthropic' | 'deepseek' | 'openai' | 'xai' | 'google';

export interface ArenaEntrant {
  id: ModelId;
  agentKey: `arena-${ModelId}`;
  /** Always names the model id it holds. */
  displayName: string;
  provider: ArenaProvider;
  /** The id sent to the provider's API. */
  model: string;
}

/** In the order the chart colours were validated; the web assigns colours by this order. */
export const ARENA_ROSTER: readonly ArenaEntrant[] = [
  {
    id: 'gemini',
    agentKey: 'arena-gemini',
    displayName: 'Gemini 3.1 Pro (preview)',
    provider: 'google',
    model: 'gemini-3.1-pro-preview',
  },
  { id: 'claude', agentKey: 'arena-claude', displayName: 'Claude Sonnet 5.5', provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { id: 'gpt', agentKey: 'arena-gpt', displayName: 'GPT-5', provider: 'openai', model: 'gpt-5' },
  { id: 'grok', agentKey: 'arena-grok', displayName: 'Grok 4.7', provider: 'xai', model: 'grok-4.7' },
  { id: 'deepseek', agentKey: 'arena-deepseek', displayName: 'DeepSeek Flash', provider: 'deepseek', model: 'deepseek-flash' },
];

/** The one strategy every entrant shares. */
export const ARENA_STRATEGY =
  'Reads current reporting on a market, estimates the probability of YES, and trades when its estimate is 10 points or more away from the price, it is not unsure, and it can cite at least two sources. The trade size and price are decided in code.';

export function arenaEntrant(agentKey: string): ArenaEntrant | undefined {
  return ARENA_ROSTER.find((e) => e.agentKey === agentKey);
}
