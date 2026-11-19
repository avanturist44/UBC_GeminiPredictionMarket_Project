import { LlmError, type LlmCompletion, type LlmProvider, type LlmRequest, type LlmUsage } from '@thesis/core';

/**
 * A provider for Gemini through Google's generateContent API.
 *
 * - The only tool a call is ever given is Grounding with Google Search. Nothing the model
 *   returns can run code here, place a trade or read the database.
 * - Replies are asked for as JSON in the prompt and validated by the wrapper. No response
 *   schema is sent, because a schema and search together are not accepted by every model.
 * - A grounded answer comes with Google's Search Suggestions, which Google's terms require
 *   to be shown with it. They are returned as `searchSuggestionsHtml`.
 * - A blocked prompt or reply is reported as a refusal, never read as an answer. Errors never
 *   carry the key or the request; the key travels in a header, not the address.
 */

export interface GoogleProviderOptions {
  apiKey: string;
  model: string;
  /** For tests: stands in for the network. */
  fetch?: typeof fetch;
}

interface GenerateContentReply {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
    groundingMetadata?: { searchEntryPoint?: { renderedContent?: string } };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  modelVersion?: string;
}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Finish reasons that mean Google withheld the reply, as opposed to cutting it short. */
const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);
/** Words Google uses when the account has no money left, as opposed to a passing rate limit. */
const NO_CREDIT = /credit|insufficient|balance|spending limit/i;

export function createGoogleProvider(options: GoogleProviderOptions): LlmProvider {
  const send = options.fetch ?? fetch;
  const url = `${ENDPOINT}/${encodeURIComponent(options.model)}:generateContent`;

  return {
    model: options.model,

    async complete(input: LlmRequest): Promise<LlmCompletion> {
      const body = {
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: 'user', parts: [{ text: input.user }] }],
        ...(input.useSearch ? { tools: [{ google_search: {} }] } : {}),
      };

      let status: number;
      let reply: unknown;
      try {
        const response = await send(url, {
          method: 'POST',
          headers: { 'x-goog-api-key': options.apiKey, 'content-type': 'application/json' },
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
      return read((reply ?? {}) as GenerateContentReply, options.model);
    },
  };
}

function read(reply: GenerateContentReply, requested: string): LlmCompletion {
  const usage = usageOf(reply.usageMetadata);
  if (reply.promptFeedback?.blockReason) {
    throw new LlmError('refused', 'The language model declined the request.', usage);
  }
  const candidate = reply.candidates?.[0];
  if (!candidate) throw new LlmError('provider', 'The language model returned no answer.', usage);
  const finish = candidate.finishReason;
  if (finish && BLOCKED.has(finish)) {
    throw new LlmError('refused', 'The language model declined the request.', usage);
  }
  if (finish && finish !== 'STOP') {
    throw new LlmError('provider', `The language model stopped early (${finish}).`, usage);
  }

  // Thought parts are the model's working, not its answer.
  const text = (candidate.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('');
  const suggestions = candidate.groundingMetadata?.searchEntryPoint?.renderedContent;
  return {
    text,
    model: reply.modelVersion ?? requested,
    usage,
    ...(typeof suggestions === 'string' && suggestions ? { searchSuggestionsHtml: suggestions } : {}),
  };
}

/** Thinking is billed as output and the search results fed back as input, so both count. */
function usageOf(usage: GenerateContentReply['usageMetadata']): LlmUsage {
  return {
    inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
  };
}

function httpError(status: number, reply: unknown, apiKey: string): LlmError {
  // Google sends { error: { code, message, status } }.
  const message = (reply as { error?: { message?: unknown } } | null)?.error?.message;
  const detail = typeof message === 'string' ? message.split(apiKey).join('[key]').slice(0, 200) : 'no reason given';

  if (status >= 500) return new LlmError('provider', `The language model returned an error (${status}).`);
  // Google answers 429 for a per-minute rate limit and a daily quota alike, in the same words.
  if (status === 429 && !NO_CREDIT.test(detail)) {
    return new LlmError('provider', 'The language model is rate limited. Try again shortly.');
  }
  // No credit, a rejected key (Google answers 400 for that), or a request the API will not
  // accept: none of these gets better by retrying, and the provider's own words say which.
  return new LlmError('unavailable', `The language model will not serve this request (${status}): ${detail}`);
}
