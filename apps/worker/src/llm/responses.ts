import { LlmError, type LlmCompletion, type LlmProvider, type LlmRequest, type LlmUsage } from '@thesis/core';

/**
 * A provider for the Responses API, which OpenAI (GPT, https://api.openai.com/v1) and xAI
 * (Grok, https://api.x.ai/v1) both serve.
 *
 * - The only tool a call is ever given is the provider's hosted web search. Nothing the model
 *   returns can run code here, place a trade or read the database.
 * - The reply is asked for in the json_schema text format, so the provider holds the model to
 *   the shape; the wrapper in packages/core still validates it.
 * - A refusal is reported as an error, never read as an answer. Errors never carry the key or
 *   the request.
 */

export interface ResponsesProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** For tests: stands in for the network. */
  fetch?: typeof fetch;
}

interface ResponsesReply {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

/** Words a provider uses when the account has no money left, as opposed to a passing rate limit. */
const NO_CREDIT = /credit|insufficient|balance|spending limit/i;

export function createResponsesProvider(options: ResponsesProviderOptions): LlmProvider {
  const send = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/responses`;

  return {
    model: options.model,

    async complete(input: LlmRequest): Promise<LlmCompletion> {
      const body = {
        model: options.model,
        instructions: input.system,
        input: input.user,
        ...(input.useSearch ? { tools: [{ type: 'web_search' }] } : {}),
        text: { format: { type: 'json_schema', name: 'reply', schema: withoutMetaKeys(input.jsonSchema), strict: true } },
      };

      let status: number;
      let reply: unknown;
      try {
        const response = await send(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(input.timeoutMs),
        });
        status = response.status;
        const raw = await response.text();
        try {
          reply = JSON.parse(raw);
        } catch {
          reply = null;
        }
      } catch (error) {
        const name = (error as { name?: unknown } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new LlmError('timeout', 'The language model did not answer in time.');
        }
        throw new LlmError('provider', 'The language model could not be reached.');
      }

      if (status < 200 || status >= 300) throw httpError(status, reply, options.apiKey);
      return read((reply ?? {}) as ResponsesReply, options.model);
    },
  };
}

/**
 * The schema without its root `$schema` and `$id`, which describe the document rather than the
 * reply and are not among the keywords strict mode lists. The rest goes as zod produced it.
 */
function withoutMetaKeys(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema;
  const bare: Record<string, unknown> = { ...schema };
  delete bare.$schema;
  delete bare.$id;
  return bare;
}

function read(reply: ResponsesReply, requested: string): LlmCompletion {
  const usage = usageOf(reply.usage);
  const content = (reply.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);

  if (content.some((part) => part.type === 'refusal') || reply.incomplete_details?.reason === 'content_filter') {
    throw new LlmError('refused', 'The language model declined the request.', usage);
  }
  if (reply.status !== undefined && reply.status !== 'completed') {
    const why = reply.incomplete_details?.reason ?? reply.status;
    throw new LlmError('provider', `The language model stopped early (${why}).`, usage);
  }
  const text = content
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('');
  return { text, model: reply.model ?? requested, usage };
}

/**
 * OpenAI counts reasoning inside output_tokens; xAI reports it outside, in total_tokens only.
 * Taking whichever is larger counts reasoning once with either.
 */
function usageOf(usage: ResponsesReply['usage']): LlmUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = Math.max(usage?.output_tokens ?? 0, (usage?.total_tokens ?? 0) - inputTokens);
  return { inputTokens, outputTokens };
}

function httpError(status: number, reply: unknown, apiKey: string): LlmError {
  // OpenAI sends { error: { message, type, code } }; xAI sends { code, error: "message" }.
  const error = (reply as { error?: unknown } | null)?.error;
  const fields = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const message = typeof error === 'string' ? error : fields.message;
  const detail = typeof message === 'string' ? message.split(apiKey).join('[key]').slice(0, 200) : 'no reason given';
  const noCredit = fields.code === 'insufficient_quota' || fields.type === 'insufficient_quota' || NO_CREDIT.test(detail);

  if (status >= 500) return new LlmError('provider', `The language model returned an error (${status}).`);
  if (status === 429 && !noCredit) return new LlmError('provider', 'The language model is rate limited. Try again shortly.');
  // No credit, a rejected key, or a request the API will not accept: none of these gets
  // better by retrying, and the provider's own words say which it is.
  return new LlmError('unavailable', `The language model will not serve this request (${status}): ${detail}`);
}
