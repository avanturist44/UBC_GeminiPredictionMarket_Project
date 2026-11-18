import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { z } from 'zod';
import { OutcomeSchema, type Outcome } from './gemini/schemas';

/**
 * The thesis format, shared by people and agents: what a thesis must contain, how its
 * content is hashed, and the rule that the side argued must follow from the probability.
 */

export const HEADLINE_MAX = 90;
export const BODY_MAX = 1200;
export const EVIDENCE_MAX = 6;
export const MIN_STAKE_USD = 1;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export const EvidenceSchema = z.object({
  claim: z.string().trim().min(1, 'Say what this source shows.').max(200),
  url: z.string().trim().max(500).refine(isHttpUrl, 'Give a full web address starting with http.'),
});

export const ThesisContentSchema = z.object({
  headline: z.string().trim().min(1, 'Write a headline.').max(HEADLINE_MAX),
  body: z.string().trim().min(1, 'Write the thesis.').max(BODY_MAX),
  evidence: z.array(EvidenceSchema).min(1, 'Add at least one source.').max(EVIDENCE_MAX),
  side: OutcomeSchema,
  /** The author's probability that the contract resolves YES. */
  probabilityYes: z.number().min(0.01).max(0.99),
});
export type ThesisContent = z.infer<typeof ThesisContentSchema>;

/** What a person sends to publish a thesis. */
export const ThesisSubmissionSchema = ThesisContentSchema.extend({
  /** Gemini's instrument symbol, verbatim. */
  symbol: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  /** Dollars of test money to put on the side argued. Whole cents. */
  stakeUsd: z
    .number()
    .min(MIN_STAKE_USD, `The smallest stake is $${MIN_STAKE_USD}.`)
    .max(1000)
    .refine((value) => Number.isInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, 'Use whole cents.'),
});
export type ThesisSubmission = z.infer<typeof ThesisSubmissionSchema>;

/** JSON with object keys in alphabetical order at every level, so equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const keccakHex = (text: string) => `0x${bytesToHex(keccak_256(new TextEncoder().encode(text)))}`;

/** The thesis id used on-chain: keccak256 of the thesis UUID in its lower-case text form. */
export function thesisOnchainId(thesisId: string): string {
  return keccakHex(thesisId.toLowerCase());
}

/**
 * keccak256 of the canonical JSON of `{ market, side, probability_yes, headline, body,
 * evidence }`. `market` is the instrument symbol and the probability has four decimals.
 * The hash is registered on-chain, which is what proves the text was not edited later.
 */
export function thesisContentHash(input: {
  market: string;
  side: Outcome;
  probabilityYes: number;
  headline: string;
  body: string;
  evidence: Array<{ claim: string; url: string }>;
}): string {
  return keccakHex(
    canonicalJson({
      market: input.market,
      side: input.side,
      probability_yes: input.probabilityYes.toFixed(4),
      headline: input.headline,
      body: input.body,
      evidence: input.evidence.map(({ claim, url }) => ({ claim, url })),
    }),
  );
}

export type SideCheck = { ok: true } | { ok: false; code: 'side_mismatch' | 'no_quote'; message: string };

const pct = (value: number) => `${Math.round(Math.round(value * 10_000) / 100)}%`;
const cents = (value: number) => `${Math.round(Math.round(value * 10_000) / 100)}¢`;

/**
 * An author must argue the side their own probability favours at the current price:
 * YES only if they put YES above what YES costs, NO only if they put NO above what NO costs.
 * Otherwise the thesis would recommend a bet its author thinks is a bad one.
 */
export function checkSideAgainstPrice(input: {
  side: Outcome;
  probabilityYes: number;
  yesBid: string | null;
  yesAsk: string | null;
}): SideCheck {
  const { side, probabilityYes } = input;
  if (side === 'yes') {
    if (input.yesAsk === null) {
      return { ok: false, code: 'no_quote', message: 'Nobody is selling YES on this market right now.' };
    }
    const ask = Number(input.yesAsk);
    if (probabilityYes > ask) return { ok: true };
    return {
      ok: false,
      code: 'side_mismatch',
      message: `You put YES at ${pct(probabilityYes)}, but buying YES costs ${cents(ask)}. Raise your probability above ${pct(ask)} or argue NO.`,
    };
  }
  if (input.yesBid === null) {
    return { ok: false, code: 'no_quote', message: 'Nobody is selling NO on this market right now.' };
  }
  const noAsk = 1 - Number(input.yesBid);
  if (1 - probabilityYes > noAsk) return { ok: true };
  return {
    ok: false,
    code: 'side_mismatch',
    message: `You put NO at ${pct(1 - probabilityYes)}, but buying NO costs ${cents(noAsk)}. Lower your YES probability below ${pct(Number(input.yesBid))} or argue YES.`,
  };
}
