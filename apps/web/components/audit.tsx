import type { AuditClaimView, AuditSummary } from '@/lib/thesis-view';
import { cn } from '@/lib/utils';

/** The audit in a few words, for a thesis card. */
export function AuditBadge({ audit }: { audit: AuditSummary | null }) {
  const base = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';
  if (!audit) return <span className={cn(base, 'text-muted-foreground')}>Audit pending</span>;
  if (audit.verdict !== 'pass') {
    return (
      <span className={cn(base, 'border-no text-no')}>
        {audit.problems > 0
          ? `Flagged: ${audit.problems} ${audit.problems === 1 ? 'claim' : 'claims'} not supported`
          : 'Flagged by the audit'}
      </span>
    );
  }
  if (audit.screenOnly) return <span className={cn(base, 'text-muted-foreground')}>Screened, claims not checked</span>;
  return (
    <span className={cn(base, 'border-primary text-primary')}>
      Checked{audit.checked > 0 ? `: ${audit.checked} ${audit.checked === 1 ? 'claim' : 'claims'}` : ''}
    </span>
  );
}

const STATUS: Record<AuditClaimView['status'], { label: string; className: string }> = {
  supported: { label: 'Supported', className: 'text-yes' },
  contradicted: { label: 'Contradicted', className: 'text-no' },
  unsupported: { label: 'Not supported', className: 'text-no' },
  unverifiable: { label: 'Could not be checked', className: 'text-muted-foreground' },
};

/** Every claim the auditor pulled out of the thesis, with what it found. */
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
  return (
    <section aria-labelledby="audit-heading" className="space-y-3">
      <h2 id="audit-heading" className="text-lg font-semibold">
        Audit
      </h2>
      {warning && (
        <p role="note" className="rounded-lg border border-no p-3 text-sm">
          This thesis was audited after it was published, and the audit found a problem: {warning}
        </p>
      )}
      {!audit ? (
        <p className="text-sm text-muted-foreground">This thesis has not been audited yet.</p>
      ) : audit.screenOnly ? (
        <p className="text-sm">
          Screened for claims of inside information. Its factual claims were not checked, because
          no language model was configured when it was audited.
        </p>
      ) : claims.length === 0 ? (
        <p className="text-sm">The auditor found no checkable factual claims in this thesis.</p>
      ) : (
        <ul className="divide-y border-y">
          {claims.map((claim, index) => {
            const status = STATUS[claim.status];
            const problem = claim.status === 'contradicted' || claim.status === 'unsupported';
            return (
              <li key={index} className={cn('space-y-1 py-3', problem && '-mx-3 bg-no/5 px-3')}>
                <p className="text-sm">{claim.text}</p>
                <p className="text-sm">
                  <span className={cn('font-medium', status.className)}>{status.label}.</span>{' '}
                  {claim.note && <span className="text-muted-foreground">{claim.note} </span>}
                  {claim.sourceUrl && (
                    <a
                      href={claim.sourceUrl}
                      target="_blank"
                      rel="noreferrer nofollow"
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      Source
                    </a>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">
        This check is automated{model && !audit?.screenOnly ? ` (${model})` : ''} and can be wrong. It
        looks at whether the stated facts hold, not whether the thesis is right.
      </p>
    </section>
  );
}
