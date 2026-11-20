import { LlmError, WORST_CALL, type LlmCompletion, type LlmProvider, type LlmRequest, type LlmUsage } from '@thesis/core';
import { httpError, postJson } from './http';

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
 * - Every reply is capped at WORST_CALL.outputTokens (`generationConfig.maxOutputTokens`).
 * - Gemini 3 bills grounding per search query, so a grounded answer counts one search for each
 *   query it lists in `webSearchQueries`, and at least one.
 */

export interface GoogleProviderOptions {
  apiKey: string;
  model: string;
  /** For tests: stands in for the network. */
  fetch?: typeof fetch;
}

interface GroundingMetadata {
  webSearchQueries?: string[];
  searchEntryPoint?: { renderedContent?: string };
}

interface GenerateContentReply {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
    groundingMetadata?: GroundingMetadata;
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
        generationConfig: { maxOutputTokens: WORST_CALL.outputTokens },
      };

      const headers = { 'x-goog-api-key': options.apiKey };
      const { status, reply } = await postJson(send, url, headers, body, input.timeoutMs);
      if (status < 200 || status >= 300) throw failed(status, reply, options.apiKey);
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
    searches: searchesOf(candidate.groundingMetadata),
    ...(typeof suggestions === 'string' && suggestions ? { searchSuggestionsHtml: suggestions } : {}),
  };
}

/**
 * Each query a grounded answer lists. One that lists none was still grounded, so it ran at least
 * one: counting it as one keeps the cap from under-counting.
 */
function searchesOf(grounding: GroundingMetadata | undefined): number {
  if (!grounding) return 0;
  const queries = grounding.webSearchQueries;
  return Array.isArray(queries) && queries.length > 0 ? queries.length : 1;
}

/** Thinking is billed as output and the search results fed back as input, so both count. */
function usageOf(usage: GenerateContentReply['usageMetadata']): LlmUsage {
  return {
    inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
  };
}

function failed(status: number, reply: unknown, apiKey: string): LlmError {
  // Google sends { error: { code, message, status, details } }. It answers 400 for a rejected
  // key, and 429 for a per-minute rate limit and an exhausted quota alike. A quota that is
  // per-day, free-tier or zero will not recover within a retry, so it is told apart by its
  // quotaId and message and reported as unavailable.
  const error = (reply as { error?: { message?: unknown; details?: unknown } } | null)?.error;
  const message = error?.message;
  if (status === 429 && staysExhausted(error)) {
    const why = typeof message === 'string' ? message : 'no reason given';
    return httpError(status, `The project's quota or billing does not allow this model: ${why}`, apiKey, {
      outOfCredit: true,
    });
  }
  return httpError(status, message, apiKey);
}

/** A 429 whose quota will not recover within the call: per-day, free-tier, or a limit of zero. */
function staysExhausted(error: { message?: unknown; details?: unknown } | undefined): boolean {
  if (typeof error?.message === 'string' && error.message.includes('limit: 0')) return true;
  const details = Array.isArray(error?.details) ? error.details : [];
  return details.some((detail) => {
    const violations = (detail as { violations?: unknown } | null)?.violations;
    return (
      Array.isArray(violations) &&
      violations.some((v) => {
        const id = (v as { quotaId?: unknown } | null)?.quotaId;
        return typeof id === 'string' && (id.includes('PerDay') || id.includes('FreeTier'));
      })
    );
  });
}
