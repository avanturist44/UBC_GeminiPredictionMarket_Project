/**
 * The part of this package that runs in a web page: Gemini's public stream and the price
 * helpers. It leaves out the REST client and the tracked-market rules, which only the
 * server uses. Import it as `@thesis/core/browser`.
 */
export * from './gemini/stream';
export * from './gemini/price-stream';
export { yesMidpoint, yesPrice, type YesQuote } from './tracked';
export { BODY_MAX, EVIDENCE_MAX, HEADLINE_MAX, MIN_STAKE_USD, checkSideAgainstPrice } from './thesis';
export * from './user-limits';
