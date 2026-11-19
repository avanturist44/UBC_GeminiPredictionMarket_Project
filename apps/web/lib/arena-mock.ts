import {
  ARENA_MODELS,
  MODEL_BY_ID,
  type ArenaMatchup,
  type ArenaMessage,
  type ArenaPoint,
  type ArenaPosition,
  type ArenaResponse,
  type ArenaStanding,
  type ArenaTrade,
  type ModelId,
} from './arena-view';

/**
 * SAMPLE DATA for the model arena, until the multi-model agents are merged.
 *
 * Everything is a pure function of time from a fixed start, so every viewer sees the same
 * history, history never changes between reads, and new points, trades and messages
 * appear as time passes. Contracts and price levels follow what the recorder has seen on
 * Gemini this week (Bitcoin near $65,000, Ether near $1,800, Brent near $92). None of the
 * results are real.
 */

export const ARENA_START = Date.UTC(2026, 10, 12, 16, 0, 0);
const HOUR = 3_600_000;
const STEP = 30 * 60_000;
const BANKROLL = 1000;

interface Behaviour {
  /** Trend per day, as a fraction of the bankroll. */
  drift: number;
  /** Size of the model's own swings. */
  vol: number;
  /** How much it moves with the market. Negative when it tends to sit on the other side. */
  beta: number;
  /** Hours between new positions. */
  every: number;
}

const BEHAVIOUR: Record<ModelId, Behaviour> = {
  gemini: { drift: -0.018, vol: 0.04, beta: 1.0, every: 3.4 },
  claude: { drift: 0.013, vol: 0.03, beta: 0.4, every: 4.1 },
  gpt: { drift: -0.027, vol: 0.05, beta: 1.5, every: 2.6 },
  grok: { drift: 0.006, vol: 0.045, beta: 1.2, every: 3.0 },
  deepseek: { drift: 0.021, vol: 0.04, beta: 0.8, every: 3.2 },
};

// ---- Deterministic noise -----------------------------------------------------------------

/** A stable number in [0, 1) for a key. */
function unit(key: string): number {
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i += 1) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const signed = (key: string) => unit(key) * 2 - 1;

/** Smooth noise in [-1, 1]: random values at whole `x`, eased between them. */
function smooth(key: string, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = signed(`${key}:${i}`);
  const b = signed(`${key}:${i + 1}`);
  return a + (b - a) * ((1 - Math.cos(f * Math.PI)) / 2);
}

function raw(id: ModelId, t: number): number {
  const b = BEHAVIOUR[id];
  const h = (t - ARENA_START) / HOUR;
  const market = smooth('market', h / 5) * 0.035 + smooth('market-fast', h / 1.5) * 0.012;
  const own = smooth(id, h / 7) * b.vol + smooth(`${id}-fast`, h / 1.2) * b.vol * 0.35 + smooth(`${id}-tick`, h * 30) * 0.0015;
  return b.drift * (h / 24) + b.beta * market + own;
}

/** A model's account value at `t`: exactly the bankroll at the start. */
export function valueAt(id: ModelId, t: number): number {
  return BANKROLL * (1 + raw(id, t) - raw(id, ARENA_START));
}

// ---- Contracts ---------------------------------------------------------------------------

const ET = 'America/New_York';
const monthDay = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: ET });
const clock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ET });

interface Family {
  /** How the invitation names this kind of contract, whatever its date or strike. */
  name: string;
  /** Hours a position is held: these contracts settle at a fixed time. */
  hold: number;
  label: (closedAt: number, key: string) => string;
}

const FAMILIES: readonly Family[] = [
  {
    name: 'Bitcoin’s 10pm close',
    hold: 7,
    label: (c, k) => `Bitcoin price on ${monthDay(c)} at 10pm ET, $${63 + Math.floor(unit(k) * 5)},000 or above`,
  },
  { name: 'Bitcoin’s 15-minute contracts', hold: 0.25, label: (c) => `Bitcoin up or down, 15 minutes to ${clock(c)} ET, Up` },
  {
    name: 'Ether’s 5pm close',
    hold: 6,
    label: (c, k) => `Ether price on ${monthDay(c)} at 5pm ET, $1,${76 + Math.floor(unit(k) * 12)}0 or above`,
  },
  { name: 'Brent oil', hold: 20, label: (c, k) => `Oil (Brent) price on ${monthDay(c)}, $${88 + Math.floor(unit(k) * 6)} or above` },
  { name: 'WTI oil', hold: 20, label: (c, k) => `Oil (WTI) price on ${monthDay(c)}, $${84 + Math.floor(unit(k) * 6)} or above` },
];

interface Planned {
  id: string;
  model: ModelId;
  family: string;
  market: string;
  side: 'yes' | 'no';
  quantity: number;
  entry: number;
  won: boolean;
  openedAt: number;
  closedAt: number;
}

/** Every position a model takes, open or settled, up to `until`. */
function plan(id: ModelId, until: number): Planned[] {
  const b = BEHAVIOUR[id];
  const winChance = Math.min(0.8, Math.max(0.2, 0.5 + b.drift * 12));
  const out: Planned[] = [];
  for (let k = 0; ; k += 1) {
    const key = `${id}:${k}`;
    const openedAt = ARENA_START + (k + 0.2 + unit(`${key}:jitter`) * 0.5) * b.every * HOUR;
    if (openedAt > until) break;
    const family = FAMILIES[Math.floor(unit(`${key}:family`) * FAMILIES.length)]!;
    const hold = family.hold * (0.8 + unit(`${key}:hold`) * 0.4);
    const closedAt = openedAt + hold * HOUR;
    const entry = Math.round((0.18 + unit(`${key}:entry`) * 0.64) * 100) / 100;
    // A stake of $10 to $20, the agents' per-trade cap.
    const quantity = Math.max(1, Math.floor((10 + unit(`${key}:stake`) * 10) / entry));
    out.push({
      id: key,
      model: id,
      family: family.name,
      market: family.label(closedAt, `${key}:strike`),
      side: unit(`${key}:side`) < 0.5 ? 'yes' : 'no',
      quantity,
      entry,
      won: unit(`${key}:won`) < winChance,
      openedAt,
      closedAt,
    });
  }
  return out;
}

/** An open position's mark: drifts from its entry toward how it will settle, with noise. */
function markOf(p: Planned, t: number): number {
  const progress = Math.min(1, Math.max(0, (t - p.openedAt) / (p.closedAt - p.openedAt)));
  const target = p.won ? 0.97 : 0.03;
  const wobble = smooth(`${p.id}:mark`, (t - p.openedAt) / (10 * 60_000)) * 0.04;
  const mark = p.entry + (target - p.entry) * progress * 0.7 + wobble;
  return Math.round(Math.min(0.98, Math.max(0.02, mark)) * 100) / 100;
}

const cents = (p: number) => `${Math.round(p * 100)}¢`;

/** The model's reasoning at moment `t`, from what it held then. */
function message(id: ModelId, k: number, t: number, positions: Planned[]): ArenaMessage {
  const key = `${id}:msg:${k}`;
  const open = positions.filter((p) => p.openedAt <= t && p.closedAt > t);
  const justOpened = open.find((p) => t - p.openedAt < 45 * 60_000);
  const estimate = (p: Planned) => {
    const sidePrice = p.entry;
    const edge = 0.1 + unit(`${p.id}:edge`) * 0.12;
    const yes = p.side === 'yes' ? sidePrice + edge : 1 - sidePrice - edge;
    return Math.round(Math.min(0.95, Math.max(0.05, yes)) * 100);
  };
  let text: string;
  if (justOpened) {
    const p = justOpened;
    const why = [
      'The last hour of reporting points the same way, from two sources.',
      'The move into the close looks like positioning, not news.',
      'The contract is pricing more risk than the spot move supports.',
    ][Math.floor(unit(`${key}:why`) * 3)];
    text = `Bought ${p.quantity} ${p.side.toUpperCase()} on ${p.market} at ${cents(p.entry)}. I put YES at ${estimate(p)}%; the market had it at ${Math.round((p.side === 'yes' ? p.entry : 1 - p.entry) * 100)}%. ${why}`;
  } else if (open.length > 0) {
    const p = open[Math.floor(unit(`${key}:pick`) * open.length)]!;
    const left = Math.max(1, Math.round((p.closedAt - t) / 60_000));
    const leftText = left >= 120 ? `${Math.round(left / 60)} hours` : `${left} minutes`;
    const mark = markOf(p, t);
    const hold = mark >= p.entry
      ? `Up ${cents(mark - p.entry)} a contract with ${leftText} to settle. Positions cannot be sold, so I am not adding to it.`
      : `Down ${cents(p.entry - mark)} a contract with ${leftText} to settle. Nothing published since explains the move, so the view stands.`;
    text = `Holding ${p.quantity} ${p.side.toUpperCase()} on ${p.market}, bought at ${cents(p.entry)}, now ${cents(mark)}. ${hold}`;
  } else {
    text = [
      'No trade. Every contract I follow is within 4 points of my estimate, which is not enough edge.',
      'No trade. Spreads on the Bitcoin contracts are wider than 6¢, so a fill would cost more than my edge.',
      'No trade. The Brent contracts settle tomorrow and the latest reporting is mixed; I would not stand behind a number.',
    ][Math.floor(unit(`${key}:idle`) * 3)]!;
  }
  return { id: key, model: id, at: new Date(t).toISOString(), text };
}

// ---- The response ------------------------------------------------------------------------

export function buildArenaMock(now: Date): ArenaResponse {
  const end = now.getTime();
  const points: ArenaPoint[] = [];
  for (let t = ARENA_START; t < end; t += STEP) points.push(pointAt(t));
  points.push(pointAt(end));

  const standings: ArenaStanding[] = ARENA_MODELS.map(({ id }) => {
    const value = Math.round(valueAt(id, end) * 100) / 100;
    return { id, valueUsd: value, changeUsd: Math.round((value - BANKROLL) * 100) / 100, changePct: ((value - BANKROLL) / BANKROLL) * 100 };
  });

  const planned = ARENA_MODELS.flatMap(({ id }) => plan(id, end));
  const trades: ArenaTrade[] = planned
    .filter((p) => p.closedAt <= end)
    .sort((a, b) => b.closedAt - a.closedAt)
    .slice(0, 60)
    .map((p) => ({
      id: p.id,
      model: p.model,
      market: p.market,
      side: p.side,
      quantity: p.quantity,
      entryPrice: p.entry,
      exitPrice: p.won ? 1 : 0,
      pnlUsd: Math.round(p.quantity * ((p.won ? 1 : 0) - p.entry) * 100) / 100,
      openedAt: new Date(p.openedAt).toISOString(),
      closedAt: new Date(p.closedAt).toISOString(),
    }));
  const positions: ArenaPosition[] = planned
    .filter((p) => p.openedAt <= end && p.closedAt > end)
    .sort((a, b) => b.openedAt - a.openedAt)
    .map((p) => {
      const mark = markOf(p, end);
      return {
        id: p.id,
        model: p.model,
        market: p.market,
        side: p.side,
        quantity: p.quantity,
        entryPrice: p.entry,
        markPrice: mark,
        pnlUsd: Math.round(p.quantity * (mark - p.entry) * 100) / 100,
        openedAt: new Date(p.openedAt).toISOString(),
      };
    });

  const messages: ArenaMessage[] = [];
  for (const { id } of ARENA_MODELS) {
    const own = planned.filter((p) => p.model === id);
    // A look every 70 to 110 minutes; keep the most recent dozen per model.
    const looks: number[] = [];
    for (let k = 0, t = ARENA_START + 20 * 60_000; t <= end; k += 1) {
      looks.push(t);
      t += (70 + unit(`${id}:gap:${k}`) * 40) * 60_000;
    }
    looks.slice(-12).forEach((t) => messages.push(message(id, looks.indexOf(t), t, own)));
  }
  messages.sort((a, b) => b.at.localeCompare(a.at));

  return {
    asOf: now.toISOString(),
    sample: true,
    bankrollUsd: BANKROLL,
    since: new Date(ARENA_START).toISOString(),
    standings,
    points,
    trades,
    positions,
    messages,
    matchup: matchupOf(standings, planned, end),
  };
}

function pointAt(t: number): ArenaPoint {
  const point = { t } as ArenaPoint;
  for (const { id } of ARENA_MODELS) point[id] = Math.round(valueAt(id, t) * 100) / 100;
  return point;
}

/**
 * Who to name on the invitation: the model in front, the one it has beaten by most on a
 * single market, and that market. "Outperform" is only ever said of the leader, about a
 * model with a lower account value.
 */
function matchupOf(standings: ArenaStanding[], planned: Planned[], end: number): ArenaMatchup | null {
  const ranked = [...standings].sort((a, b) => b.valueUsd - a.valueUsd);
  const leader = ranked[0];
  if (!leader || ranked.length < 2) return null;
  const pnl = (id: ModelId) => {
    const out = new Map<string, number>();
    for (const p of planned) {
      if (p.model !== id || p.openedAt > end) continue;
      const value = p.closedAt <= end ? (p.won ? 1 : 0) : markOf(p, end);
      // Compare like with like: the same kind of contract, whatever its date or strike.
      out.set(p.family, (out.get(p.family) ?? 0) + p.quantity * (value - p.entry));
    }
    return out;
  };
  const ahead = pnl(leader.id);
  let best: { trailer: ModelId; deal: string; edge: number } | null = null;
  for (const other of ranked.slice(1)) {
    if (other.valueUsd >= leader.valueUsd) continue;
    const behind = pnl(other.id);
    for (const deal of new Set([...ahead.keys(), ...behind.keys()])) {
      const edge = (ahead.get(deal) ?? 0) - (behind.get(deal) ?? 0);
      if (!best || edge > best.edge) best = { trailer: other.id, deal, edge };
    }
  }
  const trailer = best?.trailer ?? ranked.at(-1)!.id;
  const gapUsd = Math.round((leader.valueUsd - standings.find((s) => s.id === trailer)!.valueUsd) * 100) / 100;
  return {
    leader: leader.id,
    trailer,
    deal: best && best.edge > 0 ? best.deal : null,
    gapUsd,
    headline: `Watch ${MODEL_BY_ID[leader.id].name} outperform ${MODEL_BY_ID[trailer].name}`,
  };
}
