import { describe, expect, it } from 'vitest';
import { COMMENT_MAX, checkComment } from '../src/index';

describe('checkComment', () => {
  it('accepts a comment at the length limit and trims it', () => {
    const body = 'x'.repeat(COMMENT_MAX);
    expect(checkComment({ body: `  ${body}  ` })).toEqual({ ok: true, body });
  });

  it('refuses an empty comment and one over the limit', () => {
    expect(checkComment({ body: '   ' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(checkComment({ body: 'x'.repeat(COMMENT_MAX + 1) })).toMatchObject({ ok: false, code: 'invalid' });
    expect(checkComment(null)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses a comment that claims inside information, as theses are refused', () => {
    expect(checkComment({ body: 'My friend at the exchange told me the result early.' })).toMatchObject({
      ok: false,
      code: 'inside_info',
    });
  });

  it('collapses long runs of blank lines', () => {
    expect(checkComment({ body: 'one\n\n\n\n\ntwo' })).toEqual({ ok: true, body: 'one\n\ntwo' });
  });
});
