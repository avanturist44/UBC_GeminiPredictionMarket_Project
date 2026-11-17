import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The eleven tables from the build plan's data model. UUID primary keys, timestamptz
 * for times, numeric for prices and money (never floats). The chain holds only tips,
 * thesis hashes and market outcomes; everything else lives here.
 */

const id = () => uuid().primaryKey().defaultRandom();
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true });
/** A price or probability between 0 and 1. */
const price = () => numeric({ precision: 10, scale: 4 });
/** US dollars of test money. */
const usd = () => numeric({ precision: 14, scale: 2 });
/** Contract quantity. Gemini's quantityIncrement is 0.01. */
const quantity = () => numeric({ precision: 18, scale: 4 });

export const tradingMode = pgEnum('trading_mode', ['paper', 'gemini']);
export const authorKind = pgEnum('author_kind', ['agent', 'human']);
export const outcomeSide = pgEnum('outcome_side', ['yes', 'no']);
export const priceSource = pgEnum('price_source', ['ws', 'rest', 'backfill']);
export const thesisStatus = pgEnum('thesis_status', [
  'draft',
  'auditing',
  'blocked',
  'published',
  'resolved',
]);
export const thesisOutcome = pgEnum('thesis_outcome', ['right', 'wrong', 'void']);
export const tipStatus = pgEnum('tip_status', ['pending', 'escrowed', 'paid', 'refunded', 'failed']);
export const auditVerdict = pgEnum('audit_verdict', ['pass', 'flagged', 'blocked']);
export const agentDecision = pgEnum('agent_decision', ['trade', 'skip']);

export interface Evidence {
  claim: string;
  url: string;
}

export interface AuditClaim {
  text: string;
  status: 'supported' | 'unsupported' | 'contradicted' | 'unverifiable';
  source_url: string | null;
  note: string | null;
}

/** Trade lifecycle. `pending` is written before the external call, the rest after it. */
export type TradeStatus = 'pending' | 'filled' | 'partial' | 'rejected' | 'settled';

export const users = pgTable('users', {
  id: id(),
  displayName: text().notNull(),
  isGuest: boolean().notNull().default(true),
  tradingMode: tradingMode().notNull().default('paper'),
  paperBalanceUsd: usd().notNull().default('1000'),
  maxPerTradeUsd: usd().notNull().default('10'),
  dailyCopyCapUsd: usd().notNull().default('25'),
  circleWalletId: text(),
  walletAddress: text(),
  createdAt: createdAt(),
});

export const geminiConnections = pgTable('gemini_connections', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** AES-256-GCM with TOKEN_ENC_KEY. Never stored in the clear. */
  accessTokenEnc: text().notNull(),
  refreshTokenEnc: text().notNull(),
  expiresAt: ts().notNull(),
  scope: text().notNull(),
  termsAcceptedAt: ts(),
});

export const authors = pgTable(
  'authors',
  {
    id: id(),
    kind: authorKind().notNull(),
    /** Set for humans. */
    userId: uuid().references(() => users.id),
    /** Set for agents: momentum, news, fade. */
    agentKey: text(),
    displayName: text().notNull(),
    strategySummary: text(),
    walletAddress: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('authors_agent_key_unique').on(t.agentKey),
    uniqueIndex('authors_user_id_unique').on(t.userId),
    check(
      'authors_kind_matches_owner',
      sql`(${t.kind} = 'agent' and ${t.agentKey} is not null and ${t.userId} is null)
        or (${t.kind} = 'human' and ${t.userId} is not null and ${t.agentKey} is null)`,
    ),
  ],
);

export const markets = pgTable(
  'markets',
  {
    id: id(),
    /** Gemini's tradable symbol, verbatim, for example GEMI-BTC15M2611170745-UP. */
    instrumentSymbol: text().notNull(),
    eventTicker: text().notNull(),
    contractTicker: text().notNull(),
    title: text().notNull(),
    contractLabel: text(),
    category: text(),
    expiryAt: ts(),
    /** Gemini's contract status: approved, active, closed, under_review, settled, invalid. */
    status: text(),
    /** Gemini's marketState: open, closed, post_only. */
    marketState: text(),
    strike: numeric(),
    yesBid: price(),
    yesAsk: price(),
    lastPrice: price(),
    /** Written by the resolver only, because payouts follow from it. */
    resolutionSide: outcomeSide(),
    resolvedAt: ts(),
    tracked: boolean().notNull().default(false),
    /** Keyword groups for the Chrome extension. */
    keywords: jsonb().$type<string[][]>().notNull().default([]),
    quantityIncrement: numeric(),
    quantityMinimum: numeric(),
    priceIncrement: numeric(),
    /** `{ agency, index }` naming the index price stream used by the momentum agent. */
    sourceDetails: jsonb().$type<{ agency?: string | null; index?: string | null }>(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (t) => [
    uniqueIndex('markets_instrument_symbol_unique').on(t.instrumentSymbol),
    index('markets_event_ticker_idx').on(t.eventTicker),
    index('markets_tracked_expiry_idx').on(t.tracked, t.expiryAt),
  ],
);

export const pricePoints = pgTable(
  'price_points',
  {
    id: id(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    ts: ts().notNull(),
    yesBid: price(),
    yesAsk: price(),
    lastPrice: price(),
    source: priceSource().notNull(),
  },
  (t) => [index('price_points_market_ts_idx').on(t.marketId, t.ts)],
);

export const theses = pgTable(
  'theses',
  {
    id: id(),
    /** keccak256(thesis uuid) as 0x-prefixed hex. */
    onchainId: text().notNull(),
    authorId: uuid()
      .notNull()
      .references(() => authors.id),
    marketId: uuid()
      .notNull()
      .references(() => markets.id),
    side: outcomeSide().notNull(),
    probabilityYes: price().notNull(),
    headline: text().notNull(),
    body: text().notNull(),
    evidence: jsonb().$type<Evidence[]>().notNull().default([]),
    entryPrice: price(),
    marketYesPriceAtPublish: price(),
    /** keccak256 of the canonical JSON of the thesis content. */
    contentHash: text(),
    registerTx: text(),
    status: thesisStatus().notNull().default('draft'),
    outcome: thesisOutcome(),
    publishedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('theses_onchain_id_unique').on(t.onchainId),
    // One thesis per author per contract. Drafts and blocked attempts do not count.
    uniqueIndex('theses_one_live_per_author_market')
      .on(t.authorId, t.marketId)
      .where(sql`${t.status} in ('published', 'resolved')`),
    index('theses_market_idx').on(t.marketId),
    index('theses_status_published_idx').on(t.status, t.publishedAt),
    check('theses_headline_length', sql`char_length(${t.headline}) <= 90`),
    check('theses_body_length', sql`char_length(${t.body}) <= 1200`),
    check('theses_probability_range', sql`${t.probabilityYes} >= 0 and ${t.probabilityYes} <= 1`),
  ],
);

export const trades = pgTable(
  'trades',
  {
    id: id(),
    /** A copier's or a human author's account. Agents have only authorId. */
    userId: uuid().references(() => users.id),
    authorId: uuid().references(() => authors.id),
    marketId: uuid()
      .notNull()
      .references(() => markets.id),
    thesisId: uuid().references(() => theses.id),
    isAuthorPosition: boolean().notNull().default(false),
    side: outcomeSide().notNull(),
    quantity: quantity().notNull(),
    price: price().notNull(),
    costUsd: usd().notNull(),
    mode: tradingMode().notNull(),
    geminiOrderId: text(),
    status: text().$type<TradeStatus>().notNull().default('pending'),
    /** Positions are held to resolution. There is no sell path. */
    locked: boolean().notNull().default(true),
    payoutUsd: usd(),
    idempotencyKey: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('trades_idempotency_key_unique').on(t.idempotencyKey),
    // A thesis has exactly one author trade.
    uniqueIndex('trades_one_author_position_per_thesis')
      .on(t.thesisId)
      .where(sql`${t.isAuthorPosition}`),
    index('trades_user_created_idx').on(t.userId, t.createdAt),
    index('trades_market_idx').on(t.marketId),
    check('trades_has_owner', sql`${t.userId} is not null or ${t.authorId} is not null`),
  ],
);

export const tips = pgTable(
  'tips',
  {
    id: id(),
    thesisId: uuid()
      .notNull()
      .references(() => theses.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** USDC has 6 decimals on its ERC-20 interface. */
    amountUsdc: numeric({ precision: 12, scale: 6 }).notNull(),
    circleTxId: text(),
    depositTx: text(),
    status: tipStatus().notNull().default('pending'),
    settleTx: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('tips_thesis_idx').on(t.thesisId),
    index('tips_status_idx').on(t.status),
    check('tips_amount_positive', sql`${t.amountUsdc} > 0`),
  ],
);

export const audits = pgTable(
  'audits',
  {
    id: id(),
    thesisId: uuid()
      .notNull()
      .references(() => theses.id, { onDelete: 'cascade' }),
    verdict: auditVerdict().notNull(),
    claims: jsonb().$type<AuditClaim[]>().notNull().default([]),
    insideInfo: boolean().notNull().default(false),
    model: text(),
    createdAt: createdAt(),
  },
  (t) => [index('audits_thesis_idx').on(t.thesisId)],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: id(),
    agentKey: text().notNull(),
    marketId: uuid().references(() => markets.id),
    decision: agentDecision().notNull(),
    reason: text(),
    signal: jsonb().$type<Record<string, unknown>>(),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [index('agent_runs_agent_created_idx').on(t.agentKey, t.createdAt)],
);

export const agentState = pgTable(
  'agent_state',
  {
    agentKey: text().notNull(),
    /** UTC day. */
    day: date().notNull(),
    realizedPnlUsd: usd().notNull().default('0'),
    openExposureUsd: usd().notNull().default('0'),
    tradeCount: integer().notNull().default(0),
    halted: boolean().notNull().default(false),
    haltReason: text(),
  },
  (t) => [primaryKey({ columns: [t.agentKey, t.day] })],
);
