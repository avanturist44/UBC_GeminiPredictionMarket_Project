import {
  DATA_RULE,
  LlmError,
  WORST_CALL,
  dataBlock,
  type LlmCompletion,
  type LlmProvider,
  type LlmRequest,
  type LlmUsage,
} from '@thesis/core';
import { httpError, postJson } from './http';

/**
 * A provider for Gemini through Google's generateContent API.
 *
 * - The only tool a call is ever given is Grounding with Google Search. Nothing the model
 *   returns can run code here, place a trade or read the database.
 * - A call with search is two requests. Gemini 3 rarely searches when the same request asks for
 *   a JSON answer (measured live: 1 grounded reply in 4), and reliably when asked only to
 *   research (7 in 7). So the first request researches: the question, Google Search, a prose
 *   summary. The second answers: the caller's prompt, the research and the sources it read, no
 *   tools, and JSON mode. Research that ran no search ends the call with an empty answer and
 *   `searches: 0`, which the wrapper treats as ungrounded. A call without search is one request.
 * - The JSON Schema goes to Gemini as its own structured-output setting, and the wrapper leaves
 *   the JSON rule out of the prompt (`enforcesJsonSchema`): with the schema pasted into the
 *   prompt, Gemini almost never searched. The wrapper still validates every reply.
 * - A grounded answer comes with Google's Search Suggestions, which Google's terms require
 *   to be shown with it. They come from the research and are returned as `searchSuggestionsHtml`.
 * - A blocked prompt or reply is reported as a refusal, never read as an answer. Errors never
 *   carry the key or the request; the key travels in a header, not the address. An answer that
 *   fails after the research was answered carries the research's tokens, which were paid for.
 * - Every reply is capped at WORST_CALL.outputTokens (`generationConfig.maxOutputTokens`). The
 *   two requests share the call's timeout.
 * - Gemini 3 bills grounding per search query, so a grounded answer counts one search for each
 *   query the research lists in `webSearchQueries`, and at least one.
 */

/** The research request's own instructions, ahead of DATA_RULE. */
export const RESEARCH_SYSTEM =
  'You research prediction market questions. Search the web for current, reliable reporting and data on the question, then summarize what you found in a few sentences, citing the sources you read.';

/** Ends the answer request's message, after the research. */
export const ANSWER_NOTE =
  'The research above is what your web search found. Base your estimate on it, and cite as evidence only sources listed under "Sources read", with their web addresses exactly as listed.';

export interface GoogleProviderOptions {
  apiKey: string;
  model: string;
  /** For tests: stands in for the network. */
  fetch?: typeof fetch;
}

interface GroundingMetadata {
  webSearchQueries?: string[];
  searchEntryPoint?: { renderedContent?: string };
  /** The pages the grounded reply drew on. */
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
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
  const headers = { 'x-goog-api-key': options.apiKey };

  /** One generateContent request, read by the rules in `read`. */
  async function generate(body: unknown, timeoutMs: number): Promise<{ reply: GenerateContentReply; completion: LlmCompletion }> {
    const { status, reply } = await postJson(send, url, headers, body, timeoutMs);
    if (status < 200 || status >= 300) throw failed(status, reply, options.apiKey);
    const parsed = (reply ?? {}) as GenerateContentReply;
    return { reply: parsed, completion: read(parsed, options.model) };
  }

  return {
    model: options.model,
    enforcesJsonSchema: true,

    async complete(input: LlmRequest): Promise<LlmCompletion> {
      const answerBody = (user: string) => ({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: WORST_CALL.outputTokens,
          ...(input.jsonSchema == null
            ? {}
            : { responseMimeType: 'application/json', responseJsonSchema: input.jsonSchema }),
        },
      });
      if (!input.useSearch) return (await generate(answerBody(input.user), input.timeoutMs)).completion;

      const deadline = Date.now() + input.timeoutMs;
      const research = await generate(
        {
          systemInstruction: { parts: [{ text: `${RESEARCH_SYSTEM}\n\n${DATA_RULE}` }] },
          contents: [{ role: 'user', parts: [{ text: input.user }] }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: WORST_CALL.outputTokens },
        },
        input.timeoutMs,
      );
      const grounding = research.reply.candidates?.[0]?.groundingMetadata;
      // No search ran, so there is nothing to answer from: the wrapper asks again, or gives up.
      if (!grounding) return { text: '', model: research.completion.model, usage: research.completion.usage, searches: 0 };

      const spent = research.completion.usage;
      let answer: LlmCompletion;
      try {
        const user = `${input.user}\n\n${dataBlock('research', notesOf(research.completion.text, grounding))}\n\n${ANSWER_NOTE}`;
        // Whatever is left of the call's time: past it, nobody waits for the answer.
        answer = (await generate(answerBody(user), Math.max(1, deadline - Date.now()))).completion;
      } catch (error) {
        // The research was answered and paid for, so its tokens go with the error.
        if (error instanceof LlmError) {
          throw new LlmError(error.code, error.message, plus(spent, error.usage), { rateLimited: error.rateLimited });
        }
        throw new LlmError('provider', error instanceof Error ? error.message : String(error), spent);
      }
      const suggestions = research.completion.searchSuggestionsHtml;
      return {
        text: answer.text,
        model: answer.model,
        usage: plus(spent, answer.usage),
        searches: research.completion.searches,
        ...(suggestions ? { searchSuggestionsHtml: suggestions } : {}),
      };
    },
  };
}

const plus = (a: LlmUsage, b: LlmUsage | undefined): LlmUsage => ({
  inputTokens: a.inputTokens + (b?.inputTokens ?? 0),
  outputTokens: a.outputTokens + (b?.outputTokens ?? 0),
});

/** What the research found, with the pages it read numbered, for the answer request. */
function notesOf(text: string, grounding: GroundingMetadata): string {
  const pages = (grounding.groundingChunks ?? []).flatMap((chunk) => (chunk.web?.uri ? [chunk.web] : []));
  const sources = pages.map((page, i) => `[${i + 1}] ${page.title ?? 'Untitled'}: ${page.uri}`);
  return [text, '', 'Sources read:', ...sources].join('\n');
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
