import { percent } from '@/lib/format';
import { disagreementLines, type Disagreement } from '@/lib/market-view';
import { cn } from '@/lib/utils';

const position = (value: number) => `${Math.min(100, Math.max(0, value * 100))}%`;
const count = (n: number) => `${n} ${n === 1 ? 'thesis' : 'theses'}`;

/**
 * Where the market, the AI agents and people each put the chance of YES, on one 0 to 100
 * scale. A group with no theses has no marker, and with no theses at all there is nothing
 * to compare, so nothing is drawn.
 */
export function DisagreementBar({ disagreement }: { disagreement: Disagreement }) {
  const { marketPrice, ai, human } = disagreement;
  if (ai.average === null && human.average === null) return null;
  const lines = disagreementLines(disagreement);

  return (
    <section aria-labelledby="disagreement-heading" className="space-y-3">
      <h2 id="disagreement-heading" className="text-lg font-semibold">
        Who disagrees with the market
      </h2>
      <div aria-hidden className="pt-1">
        <div className="relative h-6">
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-secondary" />
          {marketPrice !== null && (
            <span
              className="absolute top-0 h-6 w-0.5 -translate-x-1/2 bg-foreground"
              style={{ left: position(marketPrice) }}
            />
          )}
          {ai.average !== null && (
            <span
              className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-background"
              style={{ left: position(ai.average) }}
            />
          )}
          {human.average !== null && (
            <span
              className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground bg-background"
              style={{ left: position(human.average) }}
            />
          )}
        </div>
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>0%</span>
          <span>50%</span>
          <span>100%</span>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-sm">
        {marketPrice !== null && (
          <>
            <dt className="flex items-center gap-2">
              <span aria-hidden className="inline-block h-4 w-0.5 bg-foreground" />
              Market price
            </dt>
            <dd className="font-medium tabular-nums">{percent(marketPrice)}</dd>
          </>
        )}
        {(
          [
            ['AI average', ai, 'bg-primary'],
            ['Human average', human, 'border-2 border-foreground bg-background'],
          ] as const
        ).map(
          ([label, group, mark]) =>
            group.average !== null && (
              <div key={label} className="contents">
                <dt className="flex items-center gap-2">
                  <span aria-hidden className={cn('inline-block size-3 rounded-full', mark)} />
                  {label}
                </dt>
                <dd className="tabular-nums">
                  <span className="font-medium">{percent(group.average)}</span>{' '}
                  <span className="text-muted-foreground">from {count(group.count)}</span>
                </dd>
              </div>
            ),
        )}
      </dl>
      {lines.length > 0 && <p className="text-sm">{lines.join(' ')}</p>}
    </section>
  );
}
