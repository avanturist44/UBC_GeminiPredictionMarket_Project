import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { screenThesis, validateAudit, publicSource } from '../src/audit';
import { parseAuditResponse, createXaiAuditProvider } from '../src/xai';
import { sessionToken, sessionUser, SESSION_SECONDS } from '../src/session';
const source = 'https://science.nasa.gov/moon/facts/';
const output = { inside_info: false, prohibited: false, claims: [{ text: 'The Moon is made of cheese.', status: 'contradicted', source_url: source, note: 'NASA describes a rocky body.' }] };
describe('thesis auditing and sessions', () => {
  it('blocks explicit inside knowledge before making any model request', async () => {
    let calls = 0;
    const provider = createXaiAuditProvider({ apiKey: 'test', fetch: async () => { calls++; throw new Error('must not call'); } });
    const result = await provider.audit({ headline: 'A private tip', body: 'My friend at the company gave me inside information.', evidence: [], market: { title: 'Test', symbol: 'GEMI-T-UP', expiryAt: null, yesBid: null, yesAsk: null, asOf: new Date().toISOString() } });
    expect(result.verdict).toBe('blocked'); expect(calls).toBe(0);
    expect(screenThesis('Public forecast', 'My opinion is that this outcome is more likely.')).toBeNull();
  });
  it('flags contradicted facts and derives the verdict in code', () => {
    expect(validateAudit(output, [source], 'test').verdict).toBe('flagged');
    expect(validateAudit({ ...output, inside_info: true }, [source], 'test').verdict).toBe('blocked');
    expect(() => validateAudit({ ...output, verdict: 'pass' }, [source], 'test')).toThrow();
  });
  it('downgrades invented, credentialed and private citations rather than giving a green check', () => {
    for (const url of ['https://invented.example/fact', 'https://u:p@example.com/', 'http://example.com/', 'https://127.0.0.1/', 'https://company.internal/']) {
      const result = validateAudit({ ...output, claims: [{ ...output.claims[0], status: 'supported', source_url: url }] }, [source], 'test');
      expect(result).toMatchObject({ verdict: 'flagged', claims: [{ status: 'unverifiable', source_url: null }] });
    }
    expect(publicSource('https://example.com/a#fragment')).toBe('https://example.com/a');
  });
  it('requires completed search, complete JSON and provenance metadata', () => {
    const response = { status: 'completed', model: 'test', citations: [source], output: [
      { type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] },
    ] };
    expect(parseAuditResponse(response).claims[0]?.status).toBe('contradicted');
    expect(() => parseAuditResponse({ ...response, output: response.output.slice(1) })).toThrow();
    expect(() => parseAuditResponse({ ...response, status: 'incomplete' })).toThrow();
    expect(() => parseAuditResponse({ ...response, output: [response.output[0], { type: 'message', content: [{ type: 'refusal' }] }] })).toThrow();
  });
  it('redacts upstream error bodies', async () => {
    const provider = createXaiAuditProvider({ apiKey: 'secret', fetch: async () => new Response('secret echoed by provider', { status: 401 }) });
    await expect(provider.audit({ headline: 'A forecast', body: 'Public reasoning.', evidence: [], market: { title: 'Test', symbol: 'T', expiryAt: null, yesBid: null, yesAsk: null, asOf: new Date().toISOString() } })).rejects.toThrow('audit_http_401');
  });
  it('rejects model claims invented from application context rather than author text', () => {
    const response = { status: 'completed', model: 'test', citations: [source], output: [
      { type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] },
    ] };
    const input = { headline: 'An opinion', body: 'I think YES is more likely.', evidence: [], market: { title: 'Context', symbol: 'T', expiryAt: null, yesAsk: null, yesBid: null, asOf: new Date().toISOString() } };
    expect(() => parseAuditResponse(response, input)).toThrow('audit_claim_not_authored');
    expect(parseAuditResponse(response, { ...input, body: output.claims[0]!.text }).verdict).toBe('flagged');
  });
  it('authenticates signed, bounded guest cookies and rejects tampering and expiry', () => {
    const id = randomUUID(), secret = 'x'.repeat(40), now = Date.now();
    const token = sessionToken(id, secret, now);
    expect(sessionUser(token, secret, now)).toBe(id);
    expect(sessionUser(token.replace(id, randomUUID()), secret, now)).toBeNull();
    expect(sessionUser(token, 'y'.repeat(40), now)).toBeNull();
    expect(sessionUser(token, secret, now + SESSION_SECONDS * 1000)).toBeNull();
    expect(sessionUser(`${token}.extra`, secret, now)).toBeNull();
    expect(() => sessionToken(id, 'short')).toThrow();
  });
});
