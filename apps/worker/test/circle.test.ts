import { HttpResponseError } from '@circle-fin/developer-controlled-wallets';
import { describe, expect, it } from 'vitest';
import { CircleRefused, classifyCircleError } from '../src/circle';

const response = (status: number, code: number, message = 'no') =>
  new HttpResponseError({ status, code, message, url: '/v1/w3s/developer/transactions/contractExecution', method: 'POST' });

describe('classifyCircleError', () => {
  it('calls a 4xx answer a refusal, with Circle’s code and reason', () => {
    const error = classifyCircleError(response(400, 155123, 'estimation failed'));
    expect(error).toBeInstanceOf(CircleRefused);
    expect((error as Error).message).toBe('Circle refused the request (155123): estimation failed');
  });

  it('leaves rate limits, timeouts and conflicts to be retried', () => {
    for (const status of [408, 409, 425, 429]) expect(classifyCircleError(response(status, status))).not.toBeInstanceOf(CircleRefused);
  });

  it('leaves Circle’s own outages to be retried', () => {
    for (const status of [500, 502, 503, 504]) expect(classifyCircleError(response(status, status))).not.toBeInstanceOf(CircleRefused);
  });

  it('never calls an already-used request key a refusal: the first request got through', () => {
    expect(classifyCircleError(response(400, 156020, 'Please use a new idempotency key.'))).not.toBeInstanceOf(CircleRefused);
    expect(classifyCircleError(response(400, 175403, 'please use a new idempotency key'))).not.toBeInstanceOf(CircleRefused);
  });

  it('passes errors that never got an answer through unchanged', () => {
    const timeout = new Error('connect ETIMEDOUT');
    expect(classifyCircleError(timeout)).toBe(timeout);
  });
});
