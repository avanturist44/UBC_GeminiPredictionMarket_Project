import Anthropic from '@anthropic-ai/sdk';
import { LlmError, WORST_CALL, type LlmCompletion, type LlmProvider, type LlmRequest } from '@thesis/core';
import type { Logger } from '../recorder';
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
 * - A model that ends its turn asking for a client tool it was never given (`tool_use`) is told,
 *   as that tool's error result, that only web search is available, and the call goes on. This
 *   is a continuation like a paused search, and shares their limit and the call's searches.
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
   * Most web searches one call may run, across a paused search and its continuations (default
   * WORST_CALL.searches). Sent as max_uses with Anthropic's own search tool only. A request that
   * does not report its searches is counted as having run them all.
   */
  maxSearches?: number;
  /** An Anthropic-compatible endpoint, such as https://api.deepseek.com/anthropic. Anthropic's when omitted. */
  baseUrl?: string;
  /** That endpoint's hosted search tool, sent as given in place of Anthropic's web search. */
  searchTool?: Record<string, unknown>;
  /** Told the names of any tool the model asks for without being given it. Console when omitted. */
  logger?: Pick<Logger, 'warn'>;
  /** For tests: stands in for the network. */
  fetch?: typeof fetch;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * A search call can pause after ten server-side steps, and a model can ask for a tool it was not
 * given. Either is continued at most this many times in all.
 */
const MAX_CONTINUATIONS = 3;

/** The error result sent back for each tool the model asked for and was not given. */
const STRAY_TOOL_REPLY = 'Only web search is available here. Reply now with the JSON object.';

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
  const searchTool = (allowance: number): Anthropic.Beta.BetaToolUnion =>
    options.searchTool
      ? (options.searchTool as unknown as Anthropic.Beta.BetaToolUnion)
      : { type: 'web_search_20260209', name: 'web_search', max_uses: allowance };
  let useFallbacks = !options.baseUrl;
  const logger = options.logger ?? console;

  /** `searchAllowance`: how many of the call's searches this request may still run. */
  async function request(
    input: LlmRequest,
    messages: Anthropic.Beta.BetaMessageParam[],
    searchAllowance: number,
  ): Promise<Anthropic.Beta.BetaMessage> {
    const body = (withFallbacks: boolean): Anthropic.Beta.MessageCreateParamsNonStreaming => ({
      model: options.model,
      max_tokens: WORST_CALL.outputTokens,
      system: input.system,
      messages,
      output_config: { effort },
      ...(input.useSearch ? { tools: [searchTool(searchAllowance)] } : {}),
      ...(withFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    });
    // Never resent by the SDK. The wrapper's deadline is this same timeout, so a resent request's
    // answer could never be used, and the provider bills a request it goes on running unwatched.
    const requestOptions = { timeout: input.timeoutMs, maxRetries: 0 };
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
          // max_uses counts per request, so a resumed request gets only what the call has left.
          const response = await request(input, messages, maxSearches - searches);
          const usage = response.usage;
          inputTokens +=
            usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          outputTokens += usage.output_tokens;
          // An endpoint that does not report its searches (DeepSeek's) is counted at the most.
          if (input.useSearch) searches += usage.server_tool_use?.web_search_requests ?? maxSearches;

          // Each continuation sends the conversation so far with the model's reply added as it
          // came. Only while the call has continuations and searches left; after that an
          // unfinished reply fails below as stopped early, rather than return part of an answer.
          const canContinue = turn < MAX_CONTINUATIONS && searches < maxSearches;
          const reply: Anthropic.Beta.BetaMessageParam = {
            role: 'assistant',
            content: response.content as Anthropic.Beta.BetaContentBlockParam[],
          };

          // The server paused a long search. Sending its own reply back resumes it.
          if (response.stop_reason === 'pause_turn' && canContinue) {
            messages = [...messages, reply];
            continue;
          }

          // The model asked for a client tool. It is never given one, so whatever it named does
          // not exist here: each call gets an error result telling it to answer.
          const strayTools =
            response.stop_reason === 'tool_use'
              ? response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use')
              : [];
          if (strayTools.length > 0) {
            // The names only: a tool's input is the model's text, which is never logged.
            const names = strayTools.map((block) => block.name.slice(0, 64)).join(', ');
            logger.warn(`llm: ${options.model} asked for a tool it was not given (${names})`);
            if (canContinue) {
              const results: Anthropic.Beta.BetaToolResultBlockParam[] = strayTools.map((block) => ({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: STRAY_TOOL_REPLY,
              }));
              messages = [...messages, reply, { role: 'user', content: results }];
              continue;
            }
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
        // A continuation that fails does not undo the requests answered before it: they were
        // paid for, so the error carries their tokens to be recorded.
        const answered = inputTokens + outputTokens > 0 ? { inputTokens, outputTokens } : undefined;
        if (error instanceof Anthropic.APIConnectionTimeoutError) {
          throw new LlmError('timeout', 'The language model did not answer in time.', answered);
        }
        if (error instanceof Anthropic.RateLimitError) {
          throw new LlmError('provider', 'The language model is rate limited. Try again shortly.', answered, {
            rateLimited: true,
          });
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
          throw new LlmError(
            'unavailable',
            `The language model will not serve this request (${error.status}): ${reason}`,
            answered,
          );
        }
        if (error instanceof Anthropic.APIError) {
          throw new LlmError('provider', `The language model returned an error (${error.status ?? 'no status'}).`, answered);
        }
        // Anything else, such as a reply this code cannot read. The wrapper reports it as a
        // provider error in the same words; here it can carry the tokens.
        if (answered) throw new LlmError('provider', error instanceof Error ? error.message : String(error), answered);
        throw error;
      }
    },
  };
}
