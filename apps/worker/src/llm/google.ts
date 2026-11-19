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
 * - Google bills grounding per grounded prompt, so a grounded answer counts as one search.
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
    searches: candidate.groundingMetadata ? 1 : 0,
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

function failed(status: number, reply: unknown, apiKey: string): LlmError {
  // Google sends { error: { code, message, status } }. It answers 400 for a rejected key, and
  // 429 for a per-minute rate limit and a daily quota alike, in the same words: no code says
  // an account is out of credit, so only its words can.
  const message = (reply as { error?: { message?: unknown } } | null)?.error?.message;
  return httpError(status, message, apiKey);
}
