/**
 * What `/api/arena` sends: several models trading Gemini's prediction markets from the same
 * bankroll. Plain data, safe to import from client components.
 *
 * The response says whether it is sample data. It is unless the server runs with
 * `ARENA_SOURCE=live`, and every screen that shows sample data says so.
 */

import { ARENA_ROSTER, type ArenaProvider, type ModelId } from '@thesis/core/browser';

export type { ModelId };

export interface ArenaModelMeta {
  id: ModelId;
  name: string;
  provider: string;
  /** A provider mark in `public/models`. */
  logo: string;
  /**
   * The model's line colour. Five slots of a categorical palette validated on the chart
   * surface (#18181a) for colour-blind separation; the order is the roster's order.
   * Text never takes these colours.
   */
  color: string;
}

const PROVIDER_NAME: Record<ArenaProvider, string> = {
  google: 'Google',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  deepseek: 'DeepSeek',
};

const LOOK: Record<ModelId, { logo: string; color: string }> = {
  gemini: { logo: '/models/gemini.svg', color: '#3987e5' },
  claude: { logo: '/models/claude.svg', color: '#d95926' },
  gpt: { logo: '/models/gpt.svg', color: '#199e70' },
  grok: { logo: '/models/grok.svg', color: '#c98500' },
  deepseek: { logo: '/models/deepseek.svg', color: '#9085e9' },
};

export const ARENA_MODELS: readonly ArenaModelMeta[] = ARENA_ROSTER.map((e) => ({
  id: e.id,
  name: e.displayName,
  provider: PROVIDER_NAME[e.provider],
  ...LOOK[e.id],
}));

export const MODEL_BY_ID = Object.fromEntries(ARENA_MODELS.map((m) => [m.id, m])) as Record<ModelId, ArenaModelMeta>;

export interface ArenaStanding {
  id: ModelId;
  valueUsd: number;
  /** Account value minus the bankroll. */
  changeUsd: number;
  /** The same change as a percentage of the bankroll. */
  changePct: number;
  /** The model's Arc testnet wallet, for tips. Absent until it has one. */
  walletAddress?: string;
}

/** One moment: every model's account value, in dollars, keyed by model id. */
export type ArenaPoint = { t: number } & Record<ModelId, number>;

/**
 * What Gemini's sandbox exchange did with the order placed alongside a trade. It never counts
 * toward the score; the paper ledger does. Null when no order was placed (and in sample data).
 * Only the outcome is sent, never an order id or anything about the account.
 */
export interface ArenaExchange {
  status: 'pending' | 'filled' | 'partial' | 'unfilled' | 'failed';
  quantity: number | null;
  /** The sandbox's average fill price, 0 to 1. */
  price: number | null;
}

/** Whether any trade or position on the page has a sandbox order, so the README speaks of them. */
export function showsSandboxOrders(data: Pick<ArenaResponse, 'trades' | 'positions'>): boolean {
  return [...data.trades, ...data.positions].some((row) => row.exchange !== null);
}

/** The muted line under a position or trade, or null when there is no order. */
export function exchangeLine(exchange: ArenaExchange | null): string | null {
  if (!exchange) return null;
  switch (exchange.status) {
    case 'filled':
    case 'partial': {
      const what = exchange.status === 'filled' ? 'filled' : 'partly filled';
      if (exchange.quantity === null || exchange.price === null) return `Sandbox order ${what}`;
      return `Sandbox order ${what}, ${exchange.quantity} at ${Math.round(exchange.price * 100)}¢`;
    }
    case 'unfilled':
      return 'Sandbox order not filled';
    case 'pending':
      return 'Sandbox order pending';
    case 'failed':
      return 'Sandbox order failed';
  }
}

export interface ArenaTrade {
  exchange: ArenaExchange | null;
  id: string;
  model: ModelId;
  market: string;
  side: 'yes' | 'no';
  quantity: number;
  /** What one contract cost. */
  entryPrice: number;
  /** What it paid per contract: 1 if the side won, 0 if it lost, its price back if void. */
  exitPrice: number;
  pnlUsd: number;
  openedAt: string;
  closedAt: string;
}

export interface ArenaPosition {
  exchange: ArenaExchange | null;
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
  /**
   * Google's search suggestions for a grounded Gemini answer, as Google renders them. Its
   * terms require showing them with the answer. Third-party HTML: only ever rendered inside
   * a sandboxed frame.
   */
  searchSuggestionsHtml?: string;
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

/**
 * The frame around Google's search suggestions. Google's terms need a click on a suggestion
 * to reach Google Search, so the frame may open a new tab, and that tab is a normal page. It
 * never gets scripts or this page's origin.
 */
export const SEARCH_SUGGESTIONS_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/** Google's suggestion HTML as the frame's document: links open in a new tab, no page margin. */
export function searchSuggestionsDoc(html: string): string {
  return `<!doctype html><base target="_blank"><meta charset="utf-8"><style>html,body{margin:0}</style>${html}`;
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
