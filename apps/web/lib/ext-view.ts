import { yesPrice } from '@thesis/core';
import type { ExtensionCardData, ExtensionMarketRow, ExtensionThesisRow } from '@thesis/db';
import { disagreementLines, type GroupAverage } from './market-view';

/**
 * What the Chrome extension (apps/extension) reads. The shapes are the extension's: see
 * apps/extension/mock.js. Pure functions only, so they can be tested without a database.
 */

export interface ExtMarket {
  symbol: string;
  title: string;
  /** Keyword groups: a post matches when every term of at least one group appears in it. */
  keywords: string[][];
}

export interface ExtMarketsResponse {
  asOf: string;
  markets: ExtMarket[];
}

export interface ExtThesis {
  id: string;
  side: 'YES' | 'NO';
  /** What the author paid for the side they bet, 0 to 1. */
  entryPrice: number | null;
  headline: string;
  /** The opening of the thesis, never all of it: the card is a teaser for the thesis page. */
  excerpt: string;
  author: {
    name: string;
    kind: 'agent' | 'human';
    resolved: number;
    correct: number;
    brier: number | null;
  };
}

export interface ExtSummary {
  thesisCount: number;
  yesCount: number;
  noCount: number;
  /** A few sentences built from the theses and the price. Written by code, not a model. */
  text: string;
}

export interface ExtCard {
  symbol: string;
  title: string;
  /** YES price, 0 to 1. Null when the book is empty and nothing has traded. */
  yesPrice: number | null;
  /** The most trusted public thesis, or null when there is none. */
  top: ExtThesis | null;
  /** Null when the market has no public theses. */
  summary: ExtSummary | null;
}

/** An author's record counts toward trust from this many resolved theses, as on the leaderboard. */
export const MIN_RESOLVED_FOR_TRUST = 3;
export const EXCERPT_MAX_CHARS = 180;
/** The share of a short thesis the excerpt may show. */
const EXCERPT_MAX_SHARE = 0.6;

/** "BTC price today?" with contract "Up" reads "BTC price today, Up", as on the account page. */
export function marketName(title: string, contractLabel: string | null): string {
  return contractLabel ? `${title.replace(/\?\s*$/, '')}, ${contractLabel}` : title;
}

export function toExtMarkets(rows: readonly ExtensionMarketRow[], asOf: Date): ExtMarketsResponse {
  return {
    asOf: asOf.toISOString(),
    markets: rows.map((row) => ({
      symbol: row.instrumentSymbol,
      title: marketName(row.title, row.contractLabel),
      keywords: row.keywords,
    })),
  };
}

const publishedTime = (thesis: ExtensionThesisRow) => thesis.publishedAt?.getTime() ?? 0;
const newestFirst = (a: ExtensionThesisRow, b: ExtensionThesisRow) =>
  publishedTime(b) - publishedTime(a) || b.id.localeCompare(a.id);
const trusted = (thesis: ExtensionThesisRow) =>
  thesis.record.resolved >= MIN_RESOLVED_FOR_TRUST && thesis.record.brier !== null;

/**
 * Most trusted first, as the build plan defines "top": theses by authors with at least three
 * resolved theses, best (lowest) Brier score first; then everyone else, newest first.
 */
export function rankTheses(theses: readonly ExtensionThesisRow[]): ExtensionThesisRow[] {
  const proven = theses.filter(trusted).sort((a, b) => a.record.brier! - b.record.brier! || newestFirst(a, b));
  const rest = theses.filter((thesis) => !trusted(thesis)).sort(newestFirst);
  return [...proven, ...rest];
}

/**
 * The opening of a thesis: at most 180 characters and at most 60% of it, cut at a word
 * boundary. Enough to show the argument's direction, not enough to stand in for it.
 */
export function excerpt(body: string, maxChars = EXCERPT_MAX_CHARS): string {
  const text = body.replace(/\s+/g, ' ').trim();
  const limit = Math.min(maxChars, Math.floor(text.length * EXCERPT_MAX_SHARE));
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const atWord = cut.replace(/\s+\S*$/, '');
  // One very long word: cut inside it rather than show next to nothing.
  return `${(atWord.length >= limit / 2 ? atWord : cut).trimEnd()}…`;
}

function toExtThesis(thesis: ExtensionThesisRow): ExtThesis {
  return {
    id: thesis.id,
    side: thesis.side === 'yes' ? 'YES' : 'NO',
    entryPrice: thesis.entryPrice === null ? null : Number(thesis.entryPrice),
    headline: thesis.headline,
    excerpt: excerpt(thesis.body),
    author: {
      name: thesis.authorName,
      kind: thesis.authorKind,
      resolved: thesis.record.resolved,
      correct: thesis.record.right,
      brier: thesis.record.brier,
    },
  };
}

function groupAverage(theses: readonly ExtensionThesisRow[], kind: ExtensionThesisRow['authorKind']): GroupAverage {
  const group = theses.filter((thesis) => thesis.authorKind === kind);
  if (group.length === 0) return { average: null, count: 0 };
  const sum = group.reduce((total, thesis) => total + Number(thesis.probabilityYes), 0);
  return { average: Math.round((sum / group.length) * 10_000) / 10_000, count: group.length };
}

const asSentence = (text: string) => {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * Where AI agents and people stand against the price, then the most trusted case for each
 * side other than the top thesis, which the card already shows.
 */
function summarize(
  ranked: readonly ExtensionThesisRow[],
  top: ExtensionThesisRow | null,
  marketPrice: number | null,
): ExtSummary | null {
  if (ranked.length === 0) return null;
  const yesCount = ranked.filter((thesis) => thesis.side === 'yes').length;
  const lines = disagreementLines({
    marketPrice,
    ai: groupAverage(ranked, 'agent'),
    human: groupAverage(ranked, 'human'),
  });
  for (const side of ['yes', 'no'] as const) {
    const best = ranked.find((thesis) => thesis.side === side && thesis.id !== top?.id);
    if (best) lines.push(`${side.toUpperCase()} case: ${asSentence(best.headline)}`);
  }
  return { thesisCount: ranked.length, yesCount, noCount: ranked.length - yesCount, text: lines.join(' ') };
}

export function toExtCard(data: ExtensionCardData): ExtCard {
  const { market } = data;
  const price = yesPrice({ bid: market.yesBid, ask: market.yesAsk, last: market.lastPrice });
  const ranked = rankTheses(data.theses);
  const top = ranked[0] ?? null;
  return {
    symbol: market.instrumentSymbol,
    title: marketName(market.title, market.contractLabel),
    yesPrice: price,
    top: top && toExtThesis(top),
    summary: summarize(ranked, top, price),
  };
}
