'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { ArenaChart, ModelMark } from '@/components/arena-chart';
import { usd } from '@/lib/format';
import { MODEL_BY_ID, type ArenaResponse, type ModelId } from '@/lib/arena-view';
import { signedUsd } from '@/lib/record-view';
import { useLive } from '@/lib/use-live';
import { cn } from '@/lib/utils';

/**
 * The invitation to the model arena on Home: "Watch X outperform Y on Z", with X and Y
 * drawn in colour on a small chart of every model, and the whole card as one link.
 * `rail` sits beside the feed on wide screens; `banner` above the feed below that.
 */

const ARENA_REFRESH_MS = 5000;

function Row({ data, id }: { data: ArenaResponse; id: ModelId }) {
  const s = data.standings.find((x) => x.id === id)!;
  return (
    <div className="flex items-center gap-2">
      <ModelMark id={id} size={20} />
      <span className="min-w-0 flex-1 truncate">{MODEL_BY_ID[id].name}</span>
      <span className="tabular-nums">{usd(s.valueUsd)}</span>
      <span className={cn('w-16 text-right tabular-nums', s.changeUsd > 0.004 ? 'text-yes' : s.changeUsd < -0.004 ? 'text-no' : 'text-muted-foreground')}>
        {signedUsd(s.changeUsd)}
      </span>
    </div>
  );
}

export function ArenaCard({ initial, variant }: { initial: ArenaResponse | undefined; variant: 'rail' | 'banner' }) {
  const { data } = useLive<ArenaResponse>('/api/arena', initial, ARENA_REFRESH_MS);
  // On Home a failed read shows nothing rather than an error box beside the feed.
  if (!data?.matchup) return null;
  const m = data.matchup;
  const focus = [m.leader, m.trailer];
  const label = data.sample ? 'Model arena, sample data' : 'Model arena';

  if (variant === 'banner') {
    return (
      <Link
        href="/arena"
        className="flex items-center gap-4 border-b border-border px-4 py-4 transition-colors hover:bg-card focus-visible:bg-card sm:px-6"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[13px] text-muted-foreground">{label}</p>
          <p className="text-[15px] leading-snug font-medium">
            {m.headline}
            {m.deal && <span className="font-normal text-muted-foreground"> on {m.deal}</span>}
          </p>
        </div>
        <div className="h-14 w-28 shrink-0 sm:w-40" aria-hidden>
          <ArenaChart data={data} variant="mini" focus={focus} />
        </div>
        <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      </Link>
    );
  }

  return (
    <Link
      href="/arena"
      aria-labelledby="arena-heading"
      className="group block space-y-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-input focus-visible:border-input"
    >
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <h2 id="arena-heading" className="text-[15px] leading-snug font-medium">
        {m.headline}
        {m.deal && <span className="block font-normal text-muted-foreground">on {m.deal}</span>}
      </h2>
      <div className="h-28" aria-hidden>
        <ArenaChart data={data} variant="mini" focus={focus} />
      </div>
      <div className="space-y-2 text-sm">
        <Row data={data} id={m.leader} />
        <Row data={data} id={m.trailer} />
      </div>
      <span className="inline-flex items-center gap-1 text-sm text-primary">
        See their trades and reasoning
        <ArrowRight aria-hidden className="size-4 transition-transform group-hover:translate-x-0.5" strokeWidth={1.5} />
      </span>
    </Link>
  );
}
