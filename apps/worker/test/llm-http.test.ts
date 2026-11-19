import { describe, expect, it } from 'vitest';
import { httpError, postJson } from '../src/llm/http';
import { fakeFetch } from './fake-fetch';

const KEY = 'sk-test-0123456789abcdef';

describe('the shared provider HTTP helpers', () => {
  it('reads a body that is not JSON as a null reply, keeping the status', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(await postJson(fetch, 'https://api.example.com/x', {}, { a: 1 }, 5_000)).toEqual({ status: 502, reply: null });
  });

  it('cuts out every copy of the key from the provider message', () => {
    const error = httpError(401, `key ${KEY} rejected; you sent ${KEY}`, KEY);
    expect(error.code).toBe('unavailable');
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain('key [key] rejected; you sent [key]');
  });
});
