import { z } from 'zod';
import type { Outcome } from './gemini/schemas';
import { dataBlock, type Llm } from './llm';

/**
 * The auditor: every thesis passes through it before it is published.
 *
 * 1. Screen. A phrase list and the model look for claims of inside or non-public knowledge,
 *    and for prohibited content. Either blocks the thesis.
 * 2. Extract. The model lists up to six checkable factual claims. Opinions and predictions
 *    are not claims.
 * 3. Check. Claims about this market's price or strike are checked here, in code, against
 *    the quote passed in. Every other claim goes to the model with web search.
 * 4. Verdict. `blocked` for inside information or prohibited content; `flagged` if any claim
 *    is unsupported or contradicted; otherwise `pass`.
 *
 * It decides nothing about money. It cannot place a trade or change a limit, and the only
 * tool the model is given is web search. Its result is advice shown to readers, labelled as
 * automated, except for `blocked`, which the pipeline enforces.
 */

export type ClaimStatus = 'supported' | 'unsupported' | 'contradicted' | 'unverifiable';

export interface AuditedClaim {
  text: string;
  status: ClaimStatus;
  source_url: string | null;
  note: string | null;
}

export interface AuditResult {
  verdict: 'pass' | 'flagged' | 'blocked';
  insideInfo: boolean;
  /** Set when the verdict is `blocked`: what the author needs to know. */
  blockReason: string | null;
  claims: AuditedClaim[];
  /** The model that did the checking, or `keyword-screen` when none is configured. */
  model: string;
}

export interface AuditInput {
  thesis: {
    headline: string;
    body: string;
    side: Outcome;
    probabilityYes: number;
    evidence: Array<{ claim: string; url: string }>;
  };
  market: {
    symbol: string;
    title: string;
    contractLabel: string | null;
    expiryAt: Date | null;
    strike: string | null;
    yesBid: string | null;
    yesAsk: string | null;
    lastPrice: string | null;
  };
  now: Date;
}

export const KEYWORD_SCREEN_MODEL = 'keyword-screen';

/**
 * First-person claims to non-public knowledge. Each is a way of saying "I know something
 * the market does not, from a private source". Words like "leaked" alone are left to the
 * model: a leak already reported by the press is public evidence.
 */
const INSIDE_INFO_PATTERNS: RegExp[] = [
  /\b(?:a|my)\s+(?:friend|buddy|contact|source|cousin|brother|sister|colleague|guy|person)\s+(?:at|in|inside|from|who works)\b[^.]{0,80}\b(?:told|tells|said|says|confirmed|mentioned|tipped)\b/i,
  /\bi\s+(?:work|worked)\s+(?:there|at|for|in|inside)\b/i,
  /\b(?:i'm|i am|as)\s+an?\s+(?:insider|employee|staffer)\b/i,
  /\binsider?\s+(?:info|information|knowledge|tip|source)\b/i,
  /\binside\s+(?:info|information|knowledge|source|scoop|track)\b/i,
  /\b(?:non-?public|not\s+(?:yet\s+)?public|confidential|unreleased|unannounced)\s+(?:info|information|numbers|data|figures|results|report|memo|documents?)\b/i,
  /\b(?:was|were|got)\s+leaked\s+to\s+me\b/i,
  /\bleaked\s+to\s+me\b/i,
  /\bi(?:'ve| have)?\s+(?:seen|read|got|have)\s+(?:the\s+)?(?:internal|confidential|unreleased|embargoed)\b/i,
  /\b(?:told|tipped)\s+(?:me\s+)?(?:privately|in\s+confidence|off\s+the\s+record)\b/i,
  /\bbefore\s+it(?:'s| is)\s+(?:announced|public|released)\b[^.]{0,60}\b(?:i know|trust me|told me)\b/i,
];

/** The phrases in a text that claim inside knowledge. Empty when there are none. */
export function findInsideInfoPhrases(text: string): string[] {
  const found: string[] = [];
  for (const pattern of INSIDE_INFO_PATTERNS) {
    const match = pattern.exec(text);
    if (match) found.push(match[0].trim());
  }
  return found;
}

const PROHIBITED_REASONS = {
  threat: 'It contains a threat.',
  harassment: 'It harasses a person or group.',
  personal_data: 'It gives personal details about a private person.',
  market_manipulation: 'It encourages manipulating a market.',
} as const;

const ScreenSchema = z.object({
  inside_info: z.boolean(),
  inside_info_quote: z.string().max(300).nullable(),
  prohibited: z.enum(['none', 'threat', 'harassment', 'personal_data', 'market_manipulation']),
  claims: z
    .array(
      z.object({
        text: z.string().min(1).max(300),
        /** What the claim is about: this market's own price or strike, or anything else. */
        kind: z.enum(['yes_price', 'no_price', 'strike', 'other']),
        /** For a price, in cents. For a strike, the level. Null for `other`. */
        value: z.number().nullable(),
      }),
    )
    .max(6),
});

const CheckSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int(),
      status: z.enum(['supported', 'unsupported', 'contradicted', 'unverifiable']),
      source_url: z.string().max(500).nullable(),
      note: z.string().max(240).nullable(),
    }),
  ),
});

const SCREEN_SYSTEM = `You screen a short thesis written for a prediction market before it is published. Do three things.

1. Inside information. Decide whether the author claims to know something from a private or non-public source: for example an employee, a friend at the company, a confidential document, or a leak given to them personally. Citing a leak that news outlets have already reported is public evidence and is fine. Arguing from public data, however confidently, is fine.

2. Prohibited content. Decide whether the thesis contains a threat, harassment, personal details about a private person, or encouragement to manipulate a market (for example urging readers to coordinate trades to move the price). A strong opinion about a public figure or a company is not harassment.

3. Checkable claims. List up to six factual claims the thesis relies on that could be checked against a source: numbers, dates, events that have happened, statements about what someone said or published. Do not list opinions, predictions, or the author's own probability. Quote or closely paraphrase each claim. Mark a claim "yes_price" or "no_price" if it states what YES or NO on this market costs (give the price in cents), "strike" if it states this market's strike level (give the number), and "other" for everything else.`;

const CHECK_SYSTEM = `You check factual claims from a prediction market thesis. For each numbered claim, search the web and decide:

- "supported": a reliable source agrees with it.
- "contradicted": a reliable source says otherwise.
- "unsupported": you looked and found nothing that backs it, and it is the kind of claim that would be reported if true.
- "unverifiable": it cannot be checked from public sources, or is too vague to check.

Prefer primary sources and established news outlets. The author's own links are listed; you may read them, but a claim is supported only if the source really says it. Give one source address for each claim where you found one, and a note of one sentence saying what the source shows. Judge only whether each claim is true. Whether the thesis as a whole is right is not your question.`;

const httpUrlOrNull = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const centsText = (price: number) => `${Math.round(Math.round(price * 10_000) / 100)}¢`;

/** Checks a claim about what YES or NO costs against the market's own quote. */
function checkPriceClaim(
  text: string,
  side: Outcome,
  claimedCents: number | null,
  market: AuditInput['market'],
): AuditedClaim {
  const unverifiable = (note: string): AuditedClaim => ({ text, status: 'unverifiable', source_url: null, note });
  if (claimedCents === null || !Number.isFinite(claimedCents)) {
    return unverifiable('The claim does not state a price that can be compared.');
  }
  const flip = (value: string | null) => (value === null ? null : side === 'yes' ? Number(value) : 1 - Number(value));
  // For NO, the YES bid becomes the NO ask and the YES ask the NO bid.
  const prices = [flip(market.yesBid), flip(market.yesAsk), flip(market.lastPrice)].filter(
    (price): price is number => price !== null,
  );
  if (prices.length === 0) return unverifiable('The market had no quote to compare with.');
  const claimed = claimedCents / 100;
  const low = Math.min(...prices) - 0.05;
  const high = Math.max(...prices) + 0.05;
  const shown = `${side.toUpperCase()} was quoted between ${centsText(Math.min(...prices))} and ${centsText(Math.max(...prices))} when checked.`;
  return claimed >= low - 1e-9 && claimed <= high + 1e-9
    ? { text, status: 'supported', source_url: null, note: `Checked against the market: ${shown}` }
    : { text, status: 'contradicted', source_url: null, note: `Checked against the market: ${shown}` };
}

function checkStrikeClaim(text: string, claimed: number | null, market: AuditInput['market']): AuditedClaim {
  if (claimed === null || !Number.isFinite(claimed) || market.strike === null) {
    return { text, status: 'unverifiable', source_url: null, note: 'This market has no strike on record to compare with.' };
  }
  const strike = Number(market.strike);
  const close = Math.abs(claimed - strike) <= Math.abs(strike) * 0.001 + 1e-9;
  return {
    text,
    status: close ? 'supported' : 'contradicted',
    source_url: null,
    note: `Checked against the market: the strike on record is ${strike}.`,
  };
}

/** The market, as data: its title and label come from Gemini, not from this app. */
function describeMarket(market: AuditInput['market'], now: Date): string {
  return dataBlock(
    'market',
    [
      `Market: ${market.title}${market.contractLabel ? ` (${market.contractLabel})` : ''}`,
      `Symbol: ${market.symbol}`,
      market.expiryAt ? `Closes: ${market.expiryAt.toISOString()}` : 'Closes: no end date',
      `Time now: ${now.toISOString()}`,
    ].join('\n'),
  );
}

function describeThesis(thesis: AuditInput['thesis']): string {
  return [
    `Side argued: ${thesis.side.toUpperCase()}`,
    `Headline: ${thesis.headline}`,
    `Body: ${thesis.body}`,
    'Sources given by the author:',
    ...thesis.evidence.map((e, i) => `${i + 1}. ${e.claim} (${e.url})`),
  ].join('\n');
}

function verdictOf(claims: AuditedClaim[]): 'pass' | 'flagged' {
  return claims.some((c) => c.status === 'unsupported' || c.status === 'contradicted') ? 'flagged' : 'pass';
}

/**
 * Audits one thesis. With no model configured (`llm` null) only the phrase screen runs and
 * no claims are checked; the result says so in `model`. Errors from the model are thrown,
 * so the caller can try again later: a thesis is never published on a failed audit.
 */
export async function auditThesis(input: AuditInput, llm: Llm | null): Promise<AuditResult> {
  const { thesis, market } = input;
  const text = `${thesis.headline}\n${thesis.body}\n${thesis.evidence.map((e) => e.claim).join('\n')}`;
  const model = llm?.model ?? KEYWORD_SCREEN_MODEL;

  const phrases = findInsideInfoPhrases(text);
  if (phrases.length > 0) {
    return {
      verdict: 'blocked',
      insideInfo: true,
      blockReason: `It claims inside or non-public knowledge ("${phrases[0]}"). Argue from public evidence.`,
      claims: [],
      model,
    };
  }
  if (!llm) return { verdict: 'pass', insideInfo: false, blockReason: null, claims: [], model };

  const context = `${describeMarket(market, input.now)}\n\n${dataBlock('thesis', describeThesis(thesis))}`;
  const screen = await llm.generateJson({
    purpose: 'audit-screen',
    system: SCREEN_SYSTEM,
    user: context,
    schema: ScreenSchema,
  });

  if (screen.inside_info) {
    const quote = screen.inside_info_quote?.trim();
    return {
      verdict: 'blocked',
      insideInfo: true,
      blockReason: `It claims inside or non-public knowledge${quote ? ` ("${quote.slice(0, 160)}")` : ''}. Argue from public evidence.`,
      claims: [],
      model,
    };
  }
  if (screen.prohibited !== 'none') {
    return {
      verdict: 'blocked',
      insideInfo: false,
      blockReason: PROHIBITED_REASONS[screen.prohibited],
      claims: [],
      model,
    };
  }

  // Market facts are checked here. The rest are numbered and sent to the model with search.
  const claims: Array<AuditedClaim | null> = [];
  const toSearch: Array<{ slot: number; text: string }> = [];
  screen.claims.forEach((claim, slot) => {
    if (claim.kind === 'yes_price') claims.push(checkPriceClaim(claim.text, 'yes', claim.value, market));
    else if (claim.kind === 'no_price') claims.push(checkPriceClaim(claim.text, 'no', claim.value, market));
    else if (claim.kind === 'strike') claims.push(checkStrikeClaim(claim.text, claim.value, market));
    else {
      claims.push(null);
      toSearch.push({ slot, text: claim.text });
    }
  });

  if (toSearch.length > 0) {
    const numbered = toSearch.map((claim, i) => `${i + 1}. ${claim.text}`).join('\n');
    const sources = thesis.evidence.map((e, i) => `${i + 1}. ${e.url}`).join('\n');
    const checked = await llm.generateJson({
      purpose: 'audit-check',
      system: CHECK_SYSTEM,
      user: `${describeMarket(market, input.now)}\n\n${dataBlock('claims', numbered)}\n\n${dataBlock('author_sources', sources)}\n\nReturn one result for each claim, using its number as "index".`,
      schema: CheckSchema,
      useSearch: true,
    });
    toSearch.forEach((claim, i) => {
      const result = checked.results.find((r) => r.index === i + 1);
      claims[claim.slot] = result
        ? { text: claim.text, status: result.status, source_url: httpUrlOrNull(result.source_url), note: result.note }
        : { text: claim.text, status: 'unverifiable', source_url: null, note: 'The check returned no result for this claim.' };
    });
  }

  const done = claims.filter((claim): claim is AuditedClaim => claim !== null);
  return { verdict: verdictOf(done), insideInfo: false, blockReason: null, claims: done, model };
}
