import Anthropic from '@anthropic-ai/sdk';
import { LlmError, WORST_CALL, type LlmCompletion, type LlmProvider, type LlmRequest } from '@thesis/core';
import { redact } from './http';

/**
 * The Anthropic provider for the language-model wrapper in packages/core.
 *
 * - The only tool a call is ever given is the endpoint's hosted web search. Nothing the model
 *   returns can run code here, place a trade or read the database.
 * - Replies are asked for as JSON in the prompt and validated by the wrapper. Structured
 *   output is not used, so the same request shape works with and without web search.
 * - A refusal is reported as an error, never read as an answer. Server-side fallbacks are
 *   requested by default, so a declined request is re-run on a fallback model by the API;
 *   if the account or model does not accept that parameter, calls go on without it.
 * - Another endpoint that speaks the Anthropic API (DeepSeek's) is used through `baseUrl`,
 *   with its own hosted search tool in `searchTool`. Fallbacks are Anthropic's own and are
 *   not requested there. Such an endpoint must be given its own key.
 * - Every reply is capped at WORST_CALL.outputTokens, so no call costs more than the daily
 *   dollar cap assumes.
 */

export interface AnthropicProviderOptions {
  model: string;
  /**
   * Omit to use the SDK's own credential lookup (ANTHROPIC_API_KEY and friends). Required with
   * `baseUrl`, so Anthropic credentials from the environment are never sent to another endpoint.
   */
  apiKey?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Most web searches one request may run (default WORST_CALL.searches). Applies to Anthropic's
   * own search tool only, and is what a request that does not report its searches is counted as.
   */
  maxSearches?: number;
  /** An Anthropic-compatible endpoint, such as https://api.deepseek.com/anthropic. Anthropic's when omitted. */
  baseUrl?: string;
  /** That endpoint's hosted search tool, sent as given in place of Anthropic's web search. */
  searchTool?: Record<string, unknown>;
  /** For tests: stands in for the network. */
  fetch?: typeof fetch;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** A search call can pause after ten server-side steps. Resume it at most this many times. */
const MAX_CONTINUATIONS = 3;

export function createAnthropicProvider(options: AnthropicProviderOptions): LlmProvider {
  if (options.baseUrl && !options.apiKey) {
    // Without a key passed in, the SDK reads ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN and
    // would send it to that endpoint.
    throw new Error('createAnthropicProvider: an endpoint given in baseUrl needs its own apiKey.');
  }
  const client = new Anthropic({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const effort = options.effort ?? 'medium';
  const maxSearches = options.maxSearches ?? WORST_CALL.searches;
  // Another endpoint's search tool is not in the SDK's types, so it is sent as given.
  const searchTool: Anthropic.Beta.BetaToolUnion = options.searchTool
    ? (options.searchTool as unknown as Anthropic.Beta.BetaToolUnion)
    : { type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches };
  let useFallbacks = !options.baseUrl;

  async function request(
    input: LlmRequest,
    messages: Anthropic.Beta.BetaMessageParam[],
  ): Promise<Anthropic.Beta.BetaMessage> {
    const body = (withFallbacks: boolean): Anthropic.Beta.MessageCreateParamsNonStreaming => ({
      model: options.model,
      max_tokens: WORST_CALL.outputTokens,
      system: input.system,
      messages,
      output_config: { effort },
      ...(input.useSearch ? { tools: [searchTool] } : {}),
      ...(withFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    });
    const requestOptions = { timeout: input.timeoutMs, maxRetries: 1 };
    try {
      return await client.beta.messages.create(body(useFallbacks), requestOptions);
    } catch (error) {
      // The fallbacks parameter is in beta and not every model or account takes it. A
      // rejected request is sent once more without it, and later calls leave it out.
      if (useFallbacks && error instanceof Anthropic.BadRequestError) {
        // Left out for later calls only if leaving it out is what made the request work.
        // A 400 for another reason, such as an account with no credit, fails again here.
        const response = await client.beta.messages.create(body(false), requestOptions);
        useFallbacks = false;
        return response;
      }
      throw error;
    }
  }

  return {
    model: options.model,

    async complete(input: LlmRequest): Promise<LlmCompletion> {
      const user: Anthropic.Beta.BetaMessageParam = { role: 'user', content: input.user };
      let messages: Anthropic.Beta.BetaMessageParam[] = [user];
      let inputTokens = 0;
      let outputTokens = 0;
      let searches = 0;

      try {
        for (let turn = 0; ; turn += 1) {
          const response = await request(input, messages);
          const usage = response.usage;
          inputTokens +=
            usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          outputTokens += usage.output_tokens;
          // An endpoint that does not report its searches (DeepSeek's) is counted at the most.
          if (input.useSearch) searches += usage.server_tool_use?.web_search_requests ?? maxSearches;

          if (response.stop_reason === 'pause_turn' && turn < MAX_CONTINUATIONS) {
            // The server paused a long search. Sending its own reply back resumes it.
            messages = [user, { role: 'assistant', content: response.content as Anthropic.Beta.BetaContentBlockParam[] }];
            continue;
          }
          const spent = { inputTokens, outputTokens };
          if (response.stop_reason === 'refusal') {
            throw new LlmError('refused', 'The language model declined the request.', spent);
          }
          if (response.stop_reason !== 'end_turn') {
            throw new LlmError('provider', `The language model stopped early (${response.stop_reason ?? 'unknown'}).`, spent);
          }
          const text = response.content
            .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');
          return { text, model: response.model, usage: { inputTokens, outputTokens }, searches };
        }
      } catch (error) {
        if (error instanceof LlmError) throw error;
        if (error instanceof Anthropic.APIConnectionTimeoutError) {
          throw new LlmError('timeout', 'The language model did not answer in time.');
        }
        if (error instanceof Anthropic.RateLimitError) {
          throw new LlmError('provider', 'The language model is rate limited. Try again shortly.');
        }
        // No credit, a rejected key, or a request the API will not accept: none of these
        // gets better by retrying, and the provider's own words say which it is.
        if (
          error instanceof Anthropic.AuthenticationError ||
          error instanceof Anthropic.PermissionDeniedError ||
          error instanceof Anthropic.BadRequestError ||
          error instanceof Anthropic.UnprocessableEntityError ||
          // DeepSeek answers 402 when the account's balance is used up.
          (error instanceof Anthropic.APIError && error.status === 402)
        ) {
          const detail = (error.error as { error?: { message?: unknown } } | undefined)?.error?.message;
          const reason = typeof detail === 'string' ? redact(detail, options.apiKey).slice(0, 200) : 'no reason given';
          throw new LlmError('unavailable', `The language model will not serve this request (${error.status}): ${reason}`);
        }
        if (error instanceof Anthropic.APIError) {
          throw new LlmError('provider', `The language model returned an error (${error.status ?? 'no status'}).`);
        }
        throw error;
      }
    },
  };
}
