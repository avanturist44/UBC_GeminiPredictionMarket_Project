import { LlmError } from '@thesis/core';

/**
 * What the provider adapters share: one POST with a deadline, and turning a failed status into
 * an LlmError. This is the code that keeps the key and the request out of every error message,
 * so it lives in one place.
 */

/** Words a provider uses when the account has no money left, as opposed to a passing rate limit. */
const NO_CREDIT = /credit|insufficient|balance|spending limit/i;

/** A provider's error text with the key cut out, in case the provider quoted it back. */
export const redact = (text: string, apiKey: string | undefined) => (apiKey ? text.split(apiKey).join('[key]') : text);

/**
 * POSTs `body` as JSON and reads the reply, giving up after `timeoutMs`. `reply` is null when the
 * body is not JSON. A timeout or an unreachable host is an LlmError that says nothing about the
 * request.
 */
export async function postJson(
  send: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; reply: unknown }> {
  try {
    const response = await send(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    let reply: unknown;
    try {
      reply = JSON.parse(raw);
    } catch {
      reply = null;
    }
    return { status: response.status, reply };
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new LlmError('timeout', 'The language model did not answer in time.');
    }
    throw new LlmError('provider', 'The language model could not be reached.');
  }
}

/**
 * The error for a reply with a failed status. `message` is the provider's own explanation, as
 * found in its error body. It is quoted, with the key cut out and at most 200 characters, only
 * when retrying will not help. `outOfCredit` is for a provider that says so in a code rather
 * than in words.
 */
export function httpError(
  status: number,
  message: unknown,
  apiKey: string,
  options: { outOfCredit?: boolean } = {},
): LlmError {
  const detail = typeof message === 'string' ? redact(message, apiKey).slice(0, 200) : 'no reason given';
  const outOfCredit = options.outOfCredit === true || NO_CREDIT.test(detail);

  if (status >= 500) return new LlmError('provider', `The language model returned an error (${status}).`);
  if (status === 429 && !outOfCredit) {
    return new LlmError('provider', 'The language model is rate limited. Try again shortly.', undefined, { rateLimited: true });
  }
  // No credit, a rejected key, or a request the API will not accept: none of these gets
  // better by retrying, and the provider's own words say which it is.
  return new LlmError('unavailable', `The language model will not serve this request (${status}): ${detail}`);
}
