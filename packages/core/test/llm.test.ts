import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DATA_RULE, LlmError, createLlm, type LlmCompletion, type LlmProvider, type LlmRequest } from '../src/index';

const Shape = z.object({ answer: z.number() });
const GOOD = '{"answer": 4}';
const NOTE =
  'Your previous reply ran no web search, so the sources it cited were never read. Search the web, then reply with only the JSON object.';

/** A provider that replies in turn with text and a search count, and records each request. */
function scripted(replies: Array<{ text?: string; searches?: number }>, enforcesJsonSchema?: boolean) {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    model: 'test-model',
    ...(enforcesJsonSchema === undefined ? {} : { enforcesJsonSchema }),
    async complete(request: LlmRequest): Promise<LlmCompletion> {
      requests.push(request);
      const next = replies.shift();
      if (!next) throw new Error('no reply scripted');
      return {
        text: next.text ?? GOOD,
        model: 'test-model',
        usage: { inputTokens: 10, outputTokens: 5 },
        ...(next.searches === undefined ? {} : { searches: next.searches }),
      };
    },
  };
  return { provider, requests };
}

const ask = { purpose: 'p', system: 'Add.', user: 'u', schema: Shape };

describe('createLlm.generateJson with a provider that enforces the schema', () => {
  it('a provider that enforces the schema gets no JSON rule in its prompt', async () => {
    const enforcing = scripted([{}], true);
    await createLlm({ provider: enforcing.provider }).generateJson(ask);
    const request = enforcing.requests[0]!;
    expect(request.system).toBe(['Add.', DATA_RULE].join('\n\n'));
    expect(request.system).not.toContain('Reply with a single JSON object');
    expect(request.system).not.toContain('"answer"');
    expect(request.jsonSchema).toEqual(z.toJSONSchema(Shape));

    const plain = scripted([{}]);
    await createLlm({ provider: plain.provider }).generateJson(ask);
    expect(plain.requests[0]!.system).toContain('Reply with a single JSON object');
    expect(plain.requests[0]!.system).toContain('"answer"');
  });

  it('still validates the reply and retries once', async () => {
    const { provider, requests } = scripted([{ text: '{"answer":"x"}' }, {}], true);
    expect(await createLlm({ provider }).generateJson(ask)).toEqual({ answer: 4 });
    expect(requests).toHaveLength(2);
  });
});

describe('createLlm.generateJson with requireSearch', () => {
  const search = { ...ask, useSearch: true, requireSearch: true };

  it('a search call that ran no search is asked again, then fails as ungrounded', async () => {
    const { provider, requests } = scripted([{ searches: 0 }, { searches: 0 }]);
    let before = 0;
    const used: number[] = [];
    const completed: LlmCompletion[] = [];
    const llm = createLlm({
      provider,
      beforeCall: () => void (before += 1),
      onUsage: (_p, c) => void used.push(c.usage.inputTokens),
    });
    const error = await llm
      .generateJson({ ...search, onCompletion: (c) => void completed.push(c) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({
      code: 'ungrounded',
      message: 'The language model answered without searching the web.',
    });
    expect((error as LlmError).usage).toBeUndefined();
    expect(before).toBe(2);
    expect(used).toHaveLength(2);
    expect(completed).toEqual([]);
    expect(requests[1]!.user).toBe(`u\n\n${NOTE}`);
  });

  it('an ungrounded reply followed by a grounded one returns the grounded answer', async () => {
    const { provider } = scripted([{ searches: 0 }, { text: '{"answer": 9}', searches: 2 }]);
    const completed: LlmCompletion[] = [];
    const value = await createLlm({ provider }).generateJson({ ...search, onCompletion: (c) => void completed.push(c) });
    expect(value).toEqual({ answer: 9 });
    expect(completed).toHaveLength(1);
    expect(completed[0]!.searches).toBe(2);
  });

  it('the last attempt decides the error: ungrounded after an invalid reply, invalid after an ungrounded one', async () => {
    const a = scripted([{ text: 'nope', searches: 1 }, { searches: 0 }]);
    await expect(createLlm({ provider: a.provider }).generateJson(search)).rejects.toMatchObject({ code: 'ungrounded' });
    const b = scripted([{ searches: 0 }, { text: 'nope', searches: 1 }]);
    await expect(createLlm({ provider: b.provider }).generateJson(search)).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('without requireSearch a reply with no search is accepted', async () => {
    const { provider } = scripted([{ searches: 0 }]);
    expect(await createLlm({ provider }).generateJson({ ...ask, useSearch: true })).toEqual({ answer: 4 });
  });

  it('a reply that does not report searches is accepted', async () => {
    const { provider } = scripted([{}]);
    expect(await createLlm({ provider }).generateJson(search)).toEqual({ answer: 4 });
  });
});
