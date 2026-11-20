import { ArrowUpRight, ChevronDown, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import { InfoTip } from '@/components/info-tip';
import { screenStatus, type AuditClaimView, type AuditSummary } from '@/lib/thesis-view';
import { cn } from '@/lib/utils';

/** The audit in words, from the thesis's own audit. */
function auditText(audit: AuditSummary | null): string {
  if (!audit) return 'Audit pending';
  if (audit.verdict !== 'pass') {
    return audit.problems > 0
      ? `Flagged: ${audit.problems} ${audit.problems === 1 ? 'claim' : 'claims'} not supported`
      : 'Flagged by the audit';
  }
  if (audit.screenOnly) return 'Screened, claims not checked';
  return `Checked${audit.checked > 0 ? `: ${audit.checked} ${audit.checked === 1 ? 'claim' : 'claims'}` : ''}`;
}

/**
 * The audit in a few words. `compact` is the short form for a post header ("Checked",
 * "2 flagged"); the full wording is its tooltip and its accessible name.
 */
export function AuditBadge({ audit, compact = false }: { audit: AuditSummary | null; compact?: boolean }) {
  const base = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap';
  const full = auditText(audit);
  const tone = !audit
    ? 'border-input text-muted-foreground'
    : audit.verdict !== 'pass'
      ? 'border-no/60 text-no'
      : audit.screenOnly
        ? 'border-input text-muted-foreground'
        : 'border-primary/60 text-primary';
  const short = !audit
    ? 'Auditing'
    : audit.verdict !== 'pass'
      ? audit.problems > 0
        ? `${audit.problems} flagged`
        : 'Flagged'
      : audit.screenOnly
        ? 'Screened'
        : 'Checked';
  return (
    <span className={cn(base, tone)} title={compact ? full : undefined} aria-label={compact ? full : undefined}>
      {compact ? short : full}
    </span>
  );
}

const SCREEN = {
  clear: { icon: ShieldCheck, text: 'No inside information found', tone: 'text-foreground', iconTone: 'text-primary' },
  found: { icon: ShieldAlert, text: 'Inside information flagged', tone: 'text-no', iconTone: 'text-no' },
  pending: { icon: Shield, text: 'Not screened yet', tone: 'text-muted-foreground', iconTone: 'text-muted-foreground' },
} as const;

/**
 * What the inside-information screen found. Every thesis is screened before it is
 * published, and one that claims non-public knowledge is blocked, so on a public thesis
 * this reads as a pass.
 */
export function ScreenLabel({ audit }: { audit: AuditSummary | null }) {
  const status = screenStatus(audit);
  const { icon: Icon, text, tone, iconTone } = SCREEN[status];
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <Icon aria-hidden className={cn('size-4 shrink-0', iconTone)} strokeWidth={1.75} />
      <span className={cn('font-medium', tone)}>{text}</span>
      <InfoTip label="About the inside information screen">
        Before a thesis is published, an automated screen looks for claims of non-public knowledge, such as
        “a friend at the company told me”, “I work there” or “leaked”. A thesis that makes one is blocked and
        never published.
        {audit?.screenOnly && ' Only the phrase check ran on this thesis, because no language model was configured.'}{' '}
        The screen can miss things.
      </InfoTip>
    </span>
  );
}

const STATUS: Record<AuditClaimView['status'], { label: string; className: string }> = {
  supported: { label: 'Supported', className: 'text-yes' },
  contradicted: { label: 'Contradicted', className: 'text-no' },
  unsupported: { label: 'Not supported', className: 'text-no' },
  unverifiable: { label: 'Not checked', className: 'text-muted-foreground' },
};

function ClaimRow({ claim }: { claim: AuditClaimView }) {
  const status = STATUS[claim.status];
  return (
    <li className="grid gap-x-6 gap-y-1 py-4 sm:grid-cols-[112px_minmax(0,1fr)]">
      <span className={cn('text-sm font-medium', status.className)}>{status.label}</span>
      <div className="space-y-1">
        <p className="text-[15px] leading-relaxed">{claim.text}</p>
        {(claim.note || claim.sourceUrl) && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {claim.note}{' '}
            {claim.sourceUrl && (
              <a
                href={claim.sourceUrl}
                target="_blank"
                rel="noreferrer nofollow"
                className="inline-flex items-center gap-0.5 whitespace-nowrap text-primary underline-offset-4 hover:underline"
              >
                Source
                <ArrowUpRight aria-hidden className="size-3.5" strokeWidth={1.75} />
              </a>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * Every claim the auditor pulled out of the thesis, with what it found. Problems come
 * first, then what held up; the claims it could not check are folded into one line,
 * because their notes say little beyond that.
 */
export function AuditPanel({
  audit,
  claims,
  model,
  warning,
}: {
  audit: AuditSummary | null;
  claims: AuditClaimView[];
  model: string | null;
  warning: string | null;
}) {
  const problems = claims.filter((c) => c.status === 'contradicted' || c.status === 'unsupported');
  const supported = claims.filter((c) => c.status === 'supported');
  const unchecked = claims.filter((c) => c.status === 'unverifiable');
  const shown = [...problems, ...supported];

  return (
    <section id="fact-check" aria-labelledby="audit-heading" className="scroll-mt-6 space-y-4">
      <div className="space-y-1">
        <h2 id="audit-heading" className="text-lg font-medium">
          Fact check
        </h2>
        <p className="text-sm text-muted-foreground">
          {!audit
            ? 'This thesis has not been checked yet.'
            : audit.screenOnly
              ? 'Screened for claims of inside information. Its factual claims were not checked, because no language model was configured when it was audited.'
              : claims.length === 0
                ? 'The checker found no checkable factual claims in this thesis.'
                : `An AI pulled ${claims.length} factual ${claims.length === 1 ? 'claim' : 'claims'} out of the thesis and checked each against sources.`}
        </p>
      </div>

      {warning && (
        <p role="note" className="rounded-lg border border-no/60 p-4 text-sm">
          This thesis was checked after it was published, and the check found a problem: {warning}
        </p>
      )}

      {shown.length > 0 && (
        <ul className="divide-y divide-border border-y border-border">
          {shown.map((claim, index) => (
            <ClaimRow key={index} claim={claim} />
          ))}
        </ul>
      )}

      {unchecked.length > 0 && (
        <details className="group rounded-lg border border-border">
          <summary className="flex h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 text-sm transition-colors hover:bg-secondary/60 [&::-webkit-details-marker]:hidden">
            <span>
              {unchecked.length} {unchecked.length === 1 ? 'claim' : 'claims'} could not be checked
            </span>
            <ChevronDown
              aria-hidden
              className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
              strokeWidth={1.75}
            />
          </summary>
          <ul className="divide-y divide-border border-t border-border px-4">
            {unchecked.map((claim, index) => (
              <ClaimRow key={index} claim={claim} />
            ))}
          </ul>
        </details>
      )}

      <p className="text-[13px] text-muted-foreground">
        Automated{model && !audit?.screenOnly ? ` (${model})` : ''} and can be wrong. It checks whether the stated
        facts hold, not whether the thesis is right.
      </p>
    </section>
  );
}
