import { z } from 'zod';
import type { AuditClaim } from '@thesis/db';

export function publicSource(value: string): string | null {
  try {
    const url = new URL(value);
    if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password ||
      !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':') ||
      /(^|\.)(localhost|local|internal)$/.test(url.hostname)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}
export const AuditOutputSchema = z.strictObject({
  inside_info: z.boolean(), prohibited: z.boolean(),
  claims: z.array(z.strictObject({
    text: z.string().trim().min(1).max(500),
    status: z.enum(['supported', 'unsupported', 'contradicted', 'unverifiable']),
    source_url: z.string().max(2048).nullable(), note: z.string().max(500),
  })).max(6),
});
export type AuditInput = {
  headline: string; body: string; evidence: { claim: string; url: string }[];
  market: { title: string; symbol: string; expiryAt: string | null; yesBid: string | null; yesAsk: string | null; asOf: string };
};
export type AuditResult = { verdict: 'pass' | 'flagged' | 'blocked'; insideInfo: boolean; claims: AuditClaim[]; model: string };
export interface AuditProvider { audit(input: AuditInput, signal?: AbortSignal): Promise<AuditResult> }

/** Conservative preflight; semantic screening is also mandatory in the model audit. */
export function screenThesis(headline: string, body: string): AuditResult | null {
  const text = `${headline} ${body}`.normalize('NFKC');
  const inside = /\b(insider (information|knowledge)|inside (information|knowledge)|non[- ]public|leaked|i work (at|for)|my (friend|source) (at|inside)|a friend at .{0,80}told me)\b/i.test(text);
  if (!inside) return null;
  return { verdict: 'blocked', insideInfo: true, model: 'keyword-screen-v1', claims: [{
    text: 'Claim of non-public information', status: 'unverifiable', source_url: null,
    note: 'Theses claiming inside information cannot be published. No trade was placed.',
  }] };
}

/** A generated URL is never promoted to retrieved evidence. */
export function validateAudit(value: unknown, retrievedUrls: string[], model: string): AuditResult {
  const output = AuditOutputSchema.parse(value);
  const retrieved = new Set(retrievedUrls.map(publicSource).filter(Boolean));
  const claims = output.claims.map(claim => {
    const source = claim.source_url ? publicSource(claim.source_url) : null;
    const hasSource = source !== null && retrieved.has(source);
    return { text: claim.text, status: hasSource ? claim.status : 'unverifiable' as const,
      source_url: hasSource ? source : null,
      note: hasSource ? claim.note : 'No matching retrieved public source. This claim was not verified.' };
  });
  return { verdict: output.inside_info || output.prohibited ? 'blocked'
    : claims.some(claim => claim.status !== 'supported') ? 'flagged' : 'pass',
    insideInfo: output.inside_info, claims, model: model.slice(0, 100) };
}
