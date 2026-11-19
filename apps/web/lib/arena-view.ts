/**
 * What `/api/arena` sends: several models trading Gemini's prediction markets from the same
 * bankroll. Plain data, safe to import from client components.
 *
 * The response says whether it is sample data. Until the multi-model agents are merged it
 * always is, and every screen that shows it says so.
 */

export type ModelId = 'gemini' | 'claude' | 'gpt' | 'grok' | 'qwen' | 'deepseek';

export interface ArenaModelMeta {
  id: ModelId;
  name: string;
  provider: string;
  /** A provider mark in `public/models`. */
  logo: string;
  /**
   * The model's line colour. Six slots of a categorical palette validated on the chart
   * surface (#18181a) for colour-blind separation; the order is the validated order.
   * Text never takes these colours.
   */
  color: string;
}

export const ARENA_MODELS: readonly ArenaModelMeta[] = [
  { id: 'gemini', name: 'Gemini 2.5 Pro', provider: 'Google', logo: '/models/gemini.svg', color: '#3987e5' },
  { id: 'claude', name: 'Claude Sonnet 4.5', provider: 'Anthropic', logo: '/models/claude.svg', color: '#d95926' },
  { id: 'gpt', name: 'GPT-5', provider: 'OpenAI', logo: '/models/gpt.svg', color: '#199e70' },
  { id: 'grok', name: 'Grok 4', provider: 'xAI', logo: '/models/grok.svg', color: '#c98500' },
  { id: 'qwen', name: 'Qwen3 Max', provider: 'Alibaba', logo: '/models/qwen.svg', color: '#d55181' },
  { id: 'deepseek', name: 'DeepSeek V3.1', provider: 'DeepSeek', logo: '/models/deepseek.svg', color: '#9085e9' },
];

export const MODEL_BY_ID = Object.fromEntries(ARENA_MODELS.map((m) => [m.id, m])) as Record<ModelId, ArenaModelMeta>;

export interface ArenaStanding {
  id: ModelId;
  valueUsd: number;
  /** Account value minus the bankroll. */
  changeUsd: number;
  /** The same change as a percentage of the bankroll. */
  changePct: number;
}

/** One moment: every model's account value, in dollars, keyed by model id. */
export type ArenaPoint = { t: number } & Record<ModelId, number>;

export interface ArenaTrade {
  id: string;
  model: ModelId;
  market: string;
  side: 'yes' | 'no';
  quantity: number;
  /** What one contract cost. */
  entryPrice: number;
  /** What it paid: 1 if the side won, 0 if it lost. */
  exitPrice: number;
  pnlUsd: number;
  openedAt: string;
  closedAt: string;
}

export interface ArenaPosition {
  id: string;
  model: ModelId;
  market: string;
  side: 'yes' | 'no';
  quantity: number;
  entryPrice: number;
  /** What one contract of this side is worth now. */
  markPrice: number;
  pnlUsd: number;
  openedAt: string;
}

export interface ArenaMessage {
  id: string;
  model: ModelId;
  at: string;
  text: string;
}

export interface ArenaMatchup {
  leader: ModelId;
  trailer: ModelId;
  /** The market on which the leader gained most on the trailer. */
  deal: string | null;
  gapUsd: number;
  headline: string;
}

export interface ArenaResponse {
  asOf: string;
  sample: boolean;
  bankrollUsd: number;
  since: string;
  /** In the fixed colour order of `ARENA_MODELS`. */
  standings: ArenaStanding[];
  points: ArenaPoint[];
  trades: ArenaTrade[];
  positions: ArenaPosition[];
  messages: ArenaMessage[];
  matchup: ArenaMatchup | null;
}

/** A date that reads the same on the server and in the browser. */
export function arenaDate(iso: string | number): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "+8.4%", "-12.0%". */
export function signedPct(value: number): string {
  if (Math.abs(value) < 0.05) return '0.0%';
  return `${value > 0 ? '+' : '-'}${Math.abs(value).toFixed(1)}%`;
}

/**
 * Spreads labels that want to sit at `targets` (pixels, any order) so that no two are
 * closer than `gap`, keeping them inside [top, bottom] and as near their targets as the
 * room allows. Returns positions in the same order as `targets`.
 */
export function spreadLabels(targets: readonly number[], gap: number, top: number, bottom: number): number[] {
  const order = targets.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const placed = order.map((o) => Math.min(Math.max(o.y, top), bottom));
  // Push down where two collide, then pull up from the bottom edge, then down from the top.
  for (let k = 1; k < placed.length; k += 1) placed[k] = Math.max(placed[k]!, placed[k - 1]! + gap);
  if (placed.length > 0) placed[placed.length - 1] = Math.min(placed[placed.length - 1]!, bottom);
  for (let k = placed.length - 2; k >= 0; k -= 1) placed[k] = Math.min(placed[k]!, placed[k + 1]! - gap);
  if (placed.length > 0) placed[0] = Math.max(placed[0]!, top);
  for (let k = 1; k < placed.length; k += 1) placed[k] = Math.max(placed[k]!, placed[k - 1]! + gap);
  const out = new Array<number>(targets.length);
  order.forEach((o, k) => (out[o.i] = placed[k]!));
  return out;
}
