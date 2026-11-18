import Anthropic from '@anthropic-ai/sdk';
import { LlmError, type LlmCompletion, type LlmProvider, type LlmRequest } from '@thesis/core';

/**
 * The Anthropic provider for the language-model wrapper in packages/core.
 *
 * - The only tool a call is ever given is Anthropic's hosted web search. Nothing the model
 *   returns can run code here, place a trade or read the database.
 * - Replies are asked for as JSON in the prompt and validated by the wrapper. Structured
 *   output is not used, so the same request shape works with and without web search.
 * - A refusal is reported as an error, never read as an answer. Server-side fallbacks are
 *   requested by default, so a declined request is re-run on a fallback model by the API;
 *   if the account or model does not accept that parameter, calls go on without it.
 */

export interface AnthropicProviderOptions {
  model: string;
  /** Omit to use the SDK's own credential lookup (ANTHROPIC_API_KEY and friends). */
  apiKey?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Most web searches one call may run. */
  maxSearches?: number;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** A search call can pause after ten server-side steps. Resume it at most this many times. */
const MAX_CONTINUATIONS = 3;

export function createAnthropicProvider(options: AnthropicProviderOptions): LlmProvider {
  const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  const effort = options.effort ?? 'medium';
  const maxSearches = options.maxSearches ?? 5;
  let useFallbacks = true;

  async function request(
    input: LlmRequest,
    messages: Anthropic.Beta.BetaMessageParam[],
  ): Promise<Anthropic.Beta.BetaMessage> {
    const body = (withFallbacks: boolean): Anthropic.Beta.MessageCreateParamsNonStreaming => ({
      model: options.model,
      max_tokens: 16_000,
      system: input.system,
      messages,
      output_config: { effort },
      ...(input.useSearch
        ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches }] }
        : {}),
      ...(withFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    });
    const requestOptions = { timeout: input.timeoutMs, maxRetries: 1 };
    try {
      return await client.beta.messages.create(body(useFallbacks), requestOptions);
    } catch (error) {
      // The fallbacks parameter is in beta and not every model or account takes it. A
      // rejected request is sent once more without it, and later calls leave it out.
      if (useFallbacks && error instanceof Anthropic.BadRequestError) {
        useFallbacks = false;
        return client.beta.messages.create(body(false), requestOptions);
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

      try {
        for (let turn = 0; ; turn += 1) {
          const response = await request(input, messages);
          const usage = response.usage;
          inputTokens +=
            usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          outputTokens += usage.output_tokens;

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
          return { text, model: response.model, usage: { inputTokens, outputTokens } };
        }
      } catch (error) {
        if (error instanceof LlmError) throw error;
        if (error instanceof Anthropic.APIConnectionTimeoutError) {
          throw new LlmError('timeout', 'The language model did not answer in time.');
        }
        if (error instanceof Anthropic.RateLimitError) {
          throw new LlmError('provider', 'The language model is rate limited. Try again shortly.');
        }
        if (error instanceof Anthropic.AuthenticationError) {
          throw new LlmError('provider', 'The language model rejected the API key.');
        }
        if (error instanceof Anthropic.APIError) {
          throw new LlmError('provider', `The language model returned an error (${error.status ?? 'no status'}).`);
        }
        throw error;
      }
    },
  };
}
