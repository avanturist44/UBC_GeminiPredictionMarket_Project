import { LlmError, WORST_CALL, type LlmCompletion, type LlmProvider, type LlmRequest, type LlmUsage } from '@thesis/core';
import { httpError, postJson } from './http';

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
 * - Every reply is capped at WORST_CALL.outputTokens (`max_output_tokens`). OpenAI counts
 *   reasoning inside that cap; xAI documents it as applying to visible output only.
 * - A search call is bounded at WORST_CALL.searches, in the field each vendor documents (see
 *   searchBound).
 * - Grok is asked to reason at low effort (`reasoning.effort`). Its default is high, and cannot
 *   be turned off; at high effort a search call ran past the arena's timeout.
 */

export interface ResponsesProviderOptions {
  /** Who serves `baseUrl`. The two bound a call's searches with different request fields. */
  vendor: 'openai' | 'xai';
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
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    /** xAI's count of the server-side tools a response ran. */
    server_side_tool_usage_details?: { web_search_calls?: number };
  };
}

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
        ...(input.useSearch ? { tools: [{ type: 'web_search' }], ...searchBound(options.vendor) } : {}),
        ...(options.vendor === 'xai' ? { reasoning: { effort: 'low' } } : {}),
        max_output_tokens: WORST_CALL.outputTokens,
        text: { format: { type: 'json_schema', name: 'reply', schema: withoutMetaKeys(input.jsonSchema), strict: true } },
      };

      const headers = { authorization: `Bearer ${options.apiKey}` };
      const { status, reply } = await postJson(send, url, headers, body, input.timeoutMs);
      if (status < 200 || status >= 300) throw failed(status, reply, options.apiKey);
      return read((reply ?? {}) as ResponsesReply, options.model, input.useSearch);
    },
  };
}

/**
 * The most searches one call may run. OpenAI's `max_tool_calls` caps calls to built-in tools
 * ("any further attempts to call a tool by the model will be ignored"). xAI documents
 * `max_turns` for requests: it caps the agentic turns, but a turn may run several searches in
 * parallel, so on its own it does not bound searches (a Grok call ran 16 under max_turns 5).
 * Grok is therefore sent both: `max_tool_calls` (listed in xAI's Responses reference, enforcement
 * undocumented) and a tight `max_turns`, so that either one limits the cost.
 */
function searchBound(vendor: ResponsesProviderOptions['vendor']): Record<string, number> {
  return vendor === 'openai'
    ? { max_tool_calls: WORST_CALL.searches }
    : { max_tool_calls: WORST_CALL.searches, max_turns: GROK_MAX_TURNS };
}

const GROK_MAX_TURNS = 2;

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

function read(reply: ResponsesReply, requested: string, useSearch: boolean): LlmCompletion {
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
  return { text, model: reply.model ?? requested, usage, searches: searchesOf(reply, useSearch) };
}

/**
 * OpenAI lists each search as a web_search_call output item; xAI counts them in usage. Taking
 * the larger counts them once with either. A reply with no output list says nothing, so a
 * search call is counted at the most one call is assumed to run.
 */
function searchesOf(reply: ResponsesReply, useSearch: boolean): number {
  if (!Array.isArray(reply.output)) return useSearch ? WORST_CALL.searches : 0;
  const items = reply.output.filter((item) => item.type === 'web_search_call').length;
  const reported = reply.usage?.server_side_tool_usage_details?.web_search_calls;
  return Math.max(items, typeof reported === 'number' ? reported : 0);
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

function failed(status: number, reply: unknown, apiKey: string): LlmError {
  // OpenAI sends { error: { message, type, code } }; xAI sends { code, error: "message" }.
  const error = (reply as { error?: unknown } | null)?.error;
  const fields = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const message = typeof error === 'string' ? error : fields.message;
  // OpenAI says an account has no credit with a 429 whose code is insufficient_quota.
  const outOfCredit = fields.code === 'insufficient_quota' || fields.type === 'insufficient_quota';
  return httpError(status, message, apiKey, { outOfCredit });
}
