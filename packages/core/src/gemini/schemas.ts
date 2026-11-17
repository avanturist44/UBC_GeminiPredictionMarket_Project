import { z } from 'zod';

/**
 * Zod schemas for Gemini's public Prediction Markets API.
 *
 * Field names come from Gemini's documentation and from the responses recorded in
 * Phase 0 (see packages/core/test/fixtures and docs/gemini-findings.md). Objects are
 * loose: a field Gemini adds later is kept and reported by findUnknownKeys, never a crash.
 * Prices and quantities stay decimal strings end to end. Never convert them to floats.
 */

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A decimal string such as "0.65". Numbers are accepted and stored as strings. */
export const DecimalString = z.union([
  z.string().regex(DECIMAL, 'not a decimal string'),
  z.number().transform((n) => String(n)),
]);

/**
 * A value the app shows or stores but never computes money from. It is kept as a
 * string whatever it holds, so an odd value in one event cannot reject a whole list.
 */
const DisplayValue = z.union([z.string(), z.number().transform((n) => String(n))]);

/** True for a plain decimal such as "64548.75". */
export function isDecimalString(value: string | null | undefined): value is string {
  return typeof value === 'string' && DECIMAL.test(value);
}

export const OutcomeSchema = z.enum(['yes', 'no']);
export type Outcome = z.infer<typeof OutcomeSchema>;

const SidePrices = z.looseObject({
  yes: DecimalString.nullish(),
  no: DecimalString.nullish(),
});

/**
 * Any key can be missing when a side of the book is empty.
 * Observed: bestBid = sell.yes, bestAsk = buy.yes, buy.no = 1 - bestBid, sell.no = 1 - bestAsk.
 */
export const PricesSchema = z.looseObject({
  buy: SidePrices.nullish(),
  sell: SidePrices.nullish(),
  bestBid: DecimalString.nullish(),
  bestAsk: DecimalString.nullish(),
  lastTradePrice: DecimalString.nullish(),
});

/**
 * `type` values observed: reference, above, below, over, spread, under_or_equal.
 * For short crypto windows the type is `reference` and `value` is absent until `availableAt`.
 */
export const StrikeSchema = z.looseObject({
  type: z.string().nullish(),
  /** A price level for crypto and commodities. Check isDecimalString before storing it. */
  value: DisplayValue.nullish(),
  availableAt: z.string().nullish(),
});
export type GeminiStrike = z.infer<typeof StrikeSchema>;

export const ContractSchema = z.looseObject({
  instrumentSymbol: z.string().min(1),
  ticker: z.string().min(1),
  label: z.string().nullish(),
  /** Documented: approved, active, closed, under_review, settled, invalid. */
  status: z.string().nullish(),
  /** Observed: open, closed, post_only. */
  marketState: z.string().nullish(),
  expiryDate: z.string().nullish(),
  prices: PricesSchema.nullish(),
  resolutionSide: OutcomeSchema.nullish(),
  resolvedAt: z.string().nullish(),
  /** Present once settled: the index value the contract settled against. */
  settlementValue: DisplayValue.nullish(),
  strike: StrikeSchema.nullish(),
  quantityIncrement: DecimalString.nullish(),
  quantityMinimum: DecimalString.nullish(),
  priceIncrement: DecimalString.nullish(),
  priceMinimum: DisplayValue.nullish(),
});
export type GeminiContract = z.infer<typeof ContractSchema>;

export const SourceDetailsSchema = z.looseObject({
  agency: z.string().nullish(),
  index: z.string().nullish(),
});

export const EventSchema = z.looseObject({
  ticker: z.string().min(1),
  title: z.string(),
  slug: z.string().nullish(),
  category: z.string().nullish(),
  /** Observed: binary, categorical. */
  type: z.string().nullish(),
  /** Documented: approved, active, closed, under_review, settled, invalid. */
  status: z.string(),
  expiryDate: z.string().nullish(),
  resolvedAt: z.string().nullish(),
  volume: DisplayValue.nullish(),
  sourceDetails: SourceDetailsSchema.nullish(),
  contracts: z.array(ContractSchema),
});
export type GeminiEvent = z.infer<typeof EventSchema>;

export const EventListSchema = z.looseObject({
  data: z.array(EventSchema),
  pagination: z.looseObject({
    limit: z.number().nullish(),
    offset: z.number().nullish(),
    total: z.number().nullish(),
  }),
});
export type GeminiEventList = z.infer<typeof EventListSchema>;

export const CategoriesSchema = z.looseObject({
  categories: z.array(z.string()),
});

/**
 * Every key seen in Phase 0 or named in the documentation. Keys outside these sets
 * are reported once by the client so a change in Gemini's API is noticed.
 */
const KNOWN_EVENT_KEYS = new Set([
  ...Object.keys(EventSchema.shape),
  // Seen, not used by this app.
  'id',
  'description',
  'createdAt',
  'effectiveDate',
  'eventTags',
  'events',
  'featuredImageUrl',
  'gameId',
  'imageUrl',
  'isLive',
  'participants',
  'series',
  'settlement',
  'socialImageUrl',
  'source',
  'sportsMarket',
  'startTime',
  'subcategory',
  'tags',
  'template',
  'termsLink',
  'volume24h',
  'volumeDelta24hPct',
  // Documented, not present in any response recorded in Phase 0.
  'contractOrderbooks',
]);

const KNOWN_CONTRACT_KEYS = new Set([
  ...Object.keys(ContractSchema.shape),
  // Seen, not used by this app.
  'id',
  'abbreviatedName',
  'color',
  'createdAt',
  'description',
  'effectiveDate',
  'imageUrl',
  'isCombo',
  'quoteAssetPrecision',
  'sortOrder',
  'source',
  'sportsSide',
  'target',
  'teamId',
  'termsAndConditionsUrl',
  // Documented, not present in any response recorded in Phase 0.
  'priceHistory',
]);

/** Field names the app has never seen, prefixed with where they appeared. */
export function findUnknownKeys(event: GeminiEvent): string[] {
  const unknown = new Set<string>();
  for (const key of Object.keys(event)) {
    if (!KNOWN_EVENT_KEYS.has(key)) unknown.add(`event.${key}`);
  }
  for (const contract of event.contracts) {
    for (const key of Object.keys(contract)) {
      if (!KNOWN_CONTRACT_KEYS.has(key)) unknown.add(`contract.${key}`);
    }
  }
  return [...unknown];
}
