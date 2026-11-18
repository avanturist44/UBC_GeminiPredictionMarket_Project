import { describe, expect, it } from 'vitest';
import {
  ThesisSubmissionSchema,
  canonicalJson,
  checkSideAgainstPrice,
  fromUnits,
  planOrder,
  sideAsk,
  thesisContentHash,
  thesisOnchainId,
  toUnits,
} from '../src/index';

describe('toUnits and fromUnits', () => {
  it('convert decimal strings exactly, with no float in between', () => {
    expect(toUnits('9.9979')).toBe(99979n);
    expect(toUnits('0.61')).toBe(6100n);
    expect(toUnits('1000')).toBe(10_000_000n);
    expect(toUnits('0.6100')).toBe(6100n);
    expect(fromUnits(99979n)).toBe('9.9979');
    expect(fromUnits(6100n)).toBe('0.6100');
    expect(fromUnits(-5n)).toBe('-0.0005');
  });

  it('refuse a value with more precision than the database stores', () => {
    expect(() => toUnits('0.12345')).toThrow();
    expect(() => toUnits('abc')).toThrow();
    expect(() => toUnits('1e3')).toThrow();
  });
});

describe('sideAsk', () => {
  it('is the YES ask for YES and one dollar minus the YES bid for NO', () => {
    expect(sideAsk('yes', { yesBid: '0.51', yesAsk: '0.55' })).toBe('0.5500');
    expect(sideAsk('no', { yesBid: '0.51', yesAsk: '0.55' })).toBe('0.4900');
  });

  it('is unknown when nobody is selling that side', () => {
    expect(sideAsk('yes', { yesBid: '0.51', yesAsk: null })).toBeNull();
    expect(sideAsk('no', { yesBid: null, yesAsk: '0.55' })).toBeNull();
  });
});

describe('planOrder', () => {
  const contract = { quantityIncrement: '0.01', quantityMinimum: '0.01' };

  it('rounds the quantity down to the increment and prices it exactly', () => {
    // $10 at 61 cents is 16.393... contracts: 16.39, costing exactly $9.9979.
    expect(planOrder({ budgetUsd: '10', price: '0.61', ...contract })).toEqual({
      ok: true,
      quantity: '16.3900',
      costUsd: '9.9979',
    });
  });

  it('never spends more than the budget', () => {
    for (const price of ['0.07', '0.33', '0.5', '0.62', '0.97']) {
      const plan = planOrder({ budgetUsd: '5', price, ...contract });
      expect(plan.ok).toBe(true);
      if (plan.ok) expect(toUnits(plan.costUsd) <= toUnits('5')).toBe(true);
    }
  });

  it('follows a whole-contract increment', () => {
    expect(planOrder({ budgetUsd: '5', price: '0.62', quantityIncrement: '1', quantityMinimum: '1' })).toEqual({
      ok: true,
      quantity: '8.0000',
      costUsd: '4.9600',
    });
  });

  it('fills only the size on offer when the book is thin', () => {
    expect(planOrder({ budgetUsd: '10', price: '0.61', ...contract, availableQuantity: '5.00' })).toEqual({
      ok: true,
      quantity: '5.0000',
      costUsd: '3.0500',
    });
  });

  it('refuses an order below the contract minimum', () => {
    expect(planOrder({ budgetUsd: '0.5', price: '0.62', quantityIncrement: '1', quantityMinimum: '1' })).toMatchObject({
      ok: false,
      code: 'below_minimum',
    });
    expect(planOrder({ budgetUsd: '10', price: '0.61', ...contract, availableQuantity: '0' })).toMatchObject({
      ok: false,
      code: 'below_minimum',
    });
  });

  it('refuses a price outside 0 to 1', () => {
    expect(planOrder({ budgetUsd: '10', price: '0', ...contract })).toMatchObject({ ok: false, code: 'bad_price' });
    expect(planOrder({ budgetUsd: '10', price: '1', ...contract })).toMatchObject({ ok: false, code: 'bad_price' });
  });

  it('uses hundredths when the contract gives no increment', () => {
    expect(planOrder({ budgetUsd: '1', price: '0.5', quantityIncrement: null, quantityMinimum: null })).toMatchObject({
      ok: true,
      quantity: '2.0000',
    });
  });
});

const submission = {
  symbol: 'GEMI-BRENT2611182200-HI90',
  side: 'yes' as const,
  probabilityYes: 0.7,
  stakeUsd: 5,
  headline: 'Inventories are drawing faster than the curve implies',
  body: 'Three weeks of draws and a tight prompt spread point to a close above $90.',
  evidence: [{ claim: 'EIA weekly report shows a draw', url: 'https://www.eia.gov/petroleum/supply/weekly/' }],
};

describe('ThesisSubmissionSchema', () => {
  const issues = (value: unknown) => {
    const result = ThesisSubmissionSchema.safeParse(value);
    return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
  };

  it('accepts a complete thesis', () => {
    expect(issues(submission)).toEqual([]);
  });

  it('enforces the format: headline up to 90, body up to 1,200, at least one source with a web address', () => {
    expect(issues({ ...submission, headline: 'x'.repeat(91) })).toEqual(['headline']);
    expect(issues({ ...submission, headline: '   ' })).toEqual(['headline']);
    expect(issues({ ...submission, body: 'x'.repeat(1201) })).toEqual(['body']);
    expect(issues({ ...submission, evidence: [] })).toEqual(['evidence']);
    expect(issues({ ...submission, evidence: [{ claim: 'c', url: 'javascript:alert(1)' }] })).toEqual(['evidence.0.url']);
    expect(issues({ ...submission, evidence: [{ claim: 'c', url: 'not a url' }] })).toEqual(['evidence.0.url']);
  });

  it('enforces a stake of at least one dollar, in whole cents', () => {
    expect(issues({ ...submission, stakeUsd: 0.99 })).toEqual(['stakeUsd']);
    expect(issues({ ...submission, stakeUsd: 1 })).toEqual([]);
    expect(issues({ ...submission, stakeUsd: 2.505 })).toEqual(['stakeUsd']);
  });

  it('keeps the probability away from certainty', () => {
    expect(issues({ ...submission, probabilityYes: 0 })).toEqual(['probabilityYes']);
    expect(issues({ ...submission, probabilityYes: 1 })).toEqual(['probabilityYes']);
  });
});

describe('thesis hashes', () => {
  const content = {
    market: submission.symbol,
    side: submission.side,
    probabilityYes: submission.probabilityYes,
    headline: submission.headline,
    body: submission.body,
    evidence: submission.evidence,
  };

  it('writes canonical JSON with keys in alphabetical order at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('hashes the same content to the same value, whatever order the fields arrive in', () => {
    const reordered = {
      evidence: [{ url: submission.evidence[0]!.url, claim: submission.evidence[0]!.claim }],
      body: content.body,
      headline: content.headline,
      probabilityYes: 0.7,
      side: content.side,
      market: content.market,
    };
    expect(thesisContentHash(reordered)).toBe(thesisContentHash(content));
    expect(thesisContentHash(content)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('changes the hash when any part of the content changes', () => {
    const base = thesisContentHash(content);
    expect(thesisContentHash({ ...content, body: `${content.body} ` })).not.toBe(base);
    expect(thesisContentHash({ ...content, side: 'no' })).not.toBe(base);
    expect(thesisContentHash({ ...content, probabilityYes: 0.71 })).not.toBe(base);
    expect(thesisContentHash({ ...content, market: 'GEMI-OTHER-X' })).not.toBe(base);
  });

  it('derives the on-chain id from the thesis id', () => {
    const id = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
    expect(thesisOnchainId(id)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(thesisOnchainId(id)).toBe(thesisOnchainId(id.toLowerCase()));
    // keccak256 of the empty string, as a check that the hash function is keccak and not SHA-3.
    expect(thesisOnchainId('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });
});

describe('checkSideAgainstPrice', () => {
  const quote = { yesBid: '0.51', yesAsk: '0.55' };

  it('allows YES only when the author puts YES above what YES costs', () => {
    expect(checkSideAgainstPrice({ side: 'yes', probabilityYes: 0.56, ...quote })).toEqual({ ok: true });
    expect(checkSideAgainstPrice({ side: 'yes', probabilityYes: 0.55, ...quote })).toMatchObject({
      ok: false,
      code: 'side_mismatch',
    });
  });

  it('allows NO only when the author puts NO above what NO costs', () => {
    // NO costs 49 cents. NO at 50% clears it; NO at 49% does not.
    expect(checkSideAgainstPrice({ side: 'no', probabilityYes: 0.5, ...quote })).toEqual({ ok: true });
    expect(checkSideAgainstPrice({ side: 'no', probabilityYes: 0.51, ...quote })).toMatchObject({
      ok: false,
      code: 'side_mismatch',
    });
  });

  it('says so when nobody is selling the side', () => {
    expect(checkSideAgainstPrice({ side: 'yes', probabilityYes: 0.9, yesBid: '0.5', yesAsk: null })).toMatchObject({
      ok: false,
      code: 'no_quote',
    });
    expect(checkSideAgainstPrice({ side: 'no', probabilityYes: 0.1, yesBid: null, yesAsk: '0.5' })).toMatchObject({
      ok: false,
      code: 'no_quote',
    });
  });

  it('explains the mismatch in the author’s own numbers', () => {
    const result = checkSideAgainstPrice({ side: 'yes', probabilityYes: 0.4, ...quote });
    expect(result.ok ? '' : result.message).toContain('YES at 40%');
    expect(result.ok ? '' : result.message).toContain('55¢');
  });
});
