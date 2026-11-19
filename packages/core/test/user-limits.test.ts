import { describe, expect, it } from 'vitest';
import {
  checkDailyCopyCap,
  checkNotOwnThesis,
  checkPerTradeCap,
  checkSlippage,
  checkTipCap,
  type LimitResult,
} from '../src/index';

const code = (result: LimitResult) => (result.ok ? 'ok' : result.code);

describe('user limits: each at, just under and just over its boundary', () => {
  it('per-trade cap', () => {
    expect(code(checkPerTradeCap('9.99', '10'))).toBe('ok');
    expect(code(checkPerTradeCap('10', '10'))).toBe('ok');
    expect(code(checkPerTradeCap('10.01', '10'))).toBe('per_trade_cap');
    expect(code(checkPerTradeCap('0', '10'))).toBe('bad_amount');
    // A user who lowered their cap is held to it.
    expect(code(checkPerTradeCap('5.01', '5'))).toBe('per_trade_cap');
  });

  it('daily copy cap, counting what was already copied today', () => {
    expect(code(checkDailyCopyCap('5', '19.99', '25'))).toBe('ok');
    expect(code(checkDailyCopyCap('5', '20', '25'))).toBe('ok');
    expect(code(checkDailyCopyCap('5', '20.01', '25'))).toBe('daily_cap');
    expect(code(checkDailyCopyCap('25', '0', '25'))).toBe('ok');
    expect(code(checkDailyCopyCap('0.01', '25', '25'))).toBe('daily_cap');
  });

  it('says how much of the daily allowance is left', () => {
    const result = checkDailyCopyCap('10', '20', '25');
    expect(result.ok ? '' : result.message).toContain('$5.00 left');
    expect(result.ok ? '' : result.message).toContain('midnight UTC');
  });

  it('tip cap of 0.50 USDC', () => {
    expect(code(checkTipCap('0'))).toBe('ok');
    expect(code(checkTipCap('0.49'))).toBe('ok');
    expect(code(checkTipCap('0.50'))).toBe('ok');
    expect(code(checkTipCap('0.51'))).toBe('tip_cap');
    expect(code(checkTipCap('-0.1'))).toBe('bad_tip');
  });

  it('slippage: at most 5 cents above the author’s entry', () => {
    expect(code(checkSlippage('0.66', '0.62'))).toBe('ok');
    expect(code(checkSlippage('0.67', '0.62'))).toBe('ok');
    expect(code(checkSlippage('0.6701', '0.62'))).toBe('price_moved');
    // A better price than the author's is always fine.
    expect(code(checkSlippage('0.40', '0.62'))).toBe('ok');
  });

  it('nobody copies their own thesis; an agent’s thesis has no user and anyone may copy it', () => {
    expect(code(checkNotOwnThesis('u1', 'u1'))).toBe('own_thesis');
    expect(code(checkNotOwnThesis('u1', 'u2'))).toBe('ok');
    expect(code(checkNotOwnThesis('u1', null))).toBe('ok');
  });
});
