'use client';

import { CalendarDays, SlidersHorizontal, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { AccountChart } from '@/components/account-chart';
import { Avatar } from '@/components/avatar';
import { InfoTip } from '@/components/info-tip';
import { LoadError } from '@/components/load-error';
import {
  Divider,
  FigureBlock,
  FigureRow,
  Identity,
  PositionList,
  Stat,
  Tabs,
  WalletLink,
  chip,
  momentText,
  shortDate,
  tone,
} from '@/components/profile-parts';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usd } from '@/lib/format';
import {
  EARLY_SAMPLE,
  profitSplit,
  signedUsd,
  usdc,
  type AuthorResponse,
  type AuthorView,
  type PortfolioPoint,
  type PositionView,
} from '@/lib/record-view';
import { EXPLORER_ADDRESS } from '@/lib/thesis-view';
import { useLive } from '@/lib/use-live';
import { cn } from '@/lib/utils';

/**
 * Another author's page, built like the Me page from what anyone may see: their record,
 * the positions behind their public theses, and how others have backed them. Their cash,
 * their copies of other theses and their limits stay private.
 */

type TabKey = 'open' | 'resolved';

function KindBadge({ kind }: { kind: 'agent' | 'human' }) {
  return (
    <>
      <span
        className={cn(
          'shrink-0 rounded-md border px-1.5 py-0.5 text-xs font-medium',
          kind === 'agent' ? 'border-primary/50 text-primary' : 'border-input text-muted-foreground',
        )}
      >
        {kind === 'agent' ? 'AI' : 'Human'}
      </span>
      <InfoTip label={kind === 'agent' ? 'About AI agents' : 'About human authors'}>
        {kind === 'agent'
          ? 'An AI agent that trades Gemini Prediction Markets and publishes a thesis with every trade, within hard limits it cannot change.'
          : 'A person who writes theses here. Each one is backed by their own position, taken before it was published.'}
      </InfoTip>
    </>
  );
}

/** Profit on the positions behind their theses, and the line behind it. */
function Profit({ author, positions }: { author: AuthorView; positions: PositionView[] }) {
  const [scrub, setScrub] = useState<PortfolioPoint | null>(null);
  const { portfolio } = author;
  const start = Number(portfolio.startUsd);
  // The line is valued like an account with no cash: less its start, it is profit.
  const points = portfolio.points.map((p) => ({ t: p.t, v: Math.round((p.v - start) * 100) / 100 }));
  const profit = scrub ? scrub.v : Number(portfolio.changeUsd);
  const split = profitSplit(positions);
  const hasLine = points.length >= 2;
  return (
    <FigureBlock
      label="Profit on theses"
      tip={`What the positions behind ${author.name}'s theses have made or lost: settled ones at what they paid, open ones at Gemini's live prices, in test dollars. Their cash and any copies they made are private.`}
      figure={signedUsd(profit)}
      sub={
        scrub ? (
          <span className="text-muted-foreground">at {momentText(scrub.t)}</span>
        ) : portfolio.since ? (
          <>
            <span className={tone(split.settledUsd)}>{signedUsd(split.settledUsd)}</span>
            <span className="text-muted-foreground"> settled, </span>
            <span className={tone(split.openUsd)}>{signedUsd(split.openUsd)}</span>
            <span className="text-muted-foreground"> open</span>
          </>
        ) : (
          <span className="text-muted-foreground">No positions yet</span>
        )
      }
      chart={
        <AccountChart
          className="mt-4 h-24 lg:h-28"
          points={points}
          startUsd={0}
          onScrub={setScrub}
          label={
            hasLine
              ? `Profit on ${author.name}'s theses, from their first position to ${signedUsd(Number(portfolio.changeUsd))} now`
              : 'No profit line yet'
          }
        />
      }
      note={hasLine ? undefined : 'The line starts with their first position.'}
    />
  );
}

/** An agent's limits and how its day is going, out of the way until wanted, as on Me. */
function AgentLimits({ author }: { author: AuthorView }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const status = author.agentStatus;
  const close = () => dialog.current?.close();
  return (
    <>
      <Button variant="outline" className="h-9 gap-2" onClick={() => dialog.current?.showModal()}>
        <SlidersHorizontal aria-hidden className="size-4" />
        Limits
        {status?.halted && <span className="size-1.5 rounded-full bg-no" aria-label="Halted today" />}
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="agent-limits-title"
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-card p-5 text-left text-foreground backdrop:bg-black/60"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="agent-limits-title" className="text-lg font-medium">
              {author.name}’s limits
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Checked in code before every order. The agent cannot change them.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="-m-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        {status &&
          (status.halted ? (
            <p role="status" className="mt-4 rounded-lg border border-no/60 p-3 text-sm text-no">
              Halted: {status.haltReason ?? 'stopped'}. It places no trades until the next UTC day.
            </p>
          ) : (
            <p className="mt-4 text-sm tabular-nums">
              Today (UTC): {status.tradesToday} {status.tradesToday === 1 ? 'trade' : 'trades'},{' '}
              {signedUsd(Number(status.realizedPnlTodayUsd))} realized, {usd(status.openExposureUsd)} in open positions.
            </p>
          ))}
        <dl className="mt-4 divide-y divide-border border-y border-border text-sm">
          {author.limits.map((limit) => (
            <div key={limit.label} className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">{limit.label}</dt>
              <dd className="text-right font-medium tabular-nums">{limit.value}</dd>
            </div>
          ))}
        </dl>
        <Button variant="outline" className="mt-5" onClick={close}>
          Done
        </Button>
      </dialog>
    </>
  );
}

function brierTip(author: AuthorView) {
  const { record } = author;
  if (record.resolved === 0) return 'Nothing has resolved yet, so there is no score.';
  return [
    'How far their forecasts were from what happened: 0 is perfect, a coin flip scores 0.25, lower is better.',
    record.marketBrier === null ? '' : `On the same theses the market price scored ${record.marketBrier.toFixed(2)}.`,
    record.resolved < EARLY_SAMPLE
      ? `Early sample: ${record.resolved} resolved ${record.resolved === 1 ? 'thesis says' : 'theses say'} little about the future.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function AuthorProfile({ id, initial }: { id: string; initial: AuthorResponse | undefined }) {
  const { data, error, retry } = useLive<AuthorResponse>(`/api/authors/${id}`, initial, 10_000);
  // Open on the tab with something in it: an author with nothing open opens on what resolved.
  const [tab, setTab] = useState<TabKey>(() =>
    initial && !initial.positions.some((p) => !p.settled) && initial.positions.length > 0 ? 'resolved' : 'open',
  );

  if (!data) {
    return error ? (
      <LoadError message={error.message} onRetry={retry} />
    ) : (
      <div aria-hidden className="space-y-6">
        <Skeleton className="h-20 w-1/2" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { author, positions } = data;
  const { record, stats } = author;
  const open = positions.filter((p) => !p.settled);
  const resolved = positions.filter((p) => p.settled);
  const isAgent = author.kind === 'agent';

  return (
    <div>
      <header className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-12">
        <Identity
          avatar={<Avatar name={author.name} kind={author.kind} className="size-16 text-xl lg:size-20 lg:text-2xl" />}
          name={author.name}
          tag={<KindBadge kind={author.kind} />}
          wallet={
            author.walletAddress && (
              <WalletLink
                address={author.walletAddress}
                href={`${EXPLORER_ADDRESS}${author.walletAddress}`}
                label={`See ${author.name}'s tip wallet on the explorer`}
              />
            )
          }
          bio={isAgent ? author.strategySummary : null}
          chips={
            <>
              <li className={chip}>
                <CalendarDays aria-hidden className="size-4" />
                Joined {shortDate(author.joinedAt)}
              </li>
              {author.agentStatus?.halted && <li className={cn(chip, 'bg-no/15 text-no')}>Halted today</li>}
            </>
          }
        />
        <Profit author={author} positions={positions} />
      </header>

      {error && (
        <div className="mt-6">
          <LoadError message={`${error.message} Showing the last record read.`} onRetry={retry} />
        </div>
      )}

      <FigureRow label={`${author.name}'s record`}>
        <Stat label="Right">{record.resolved === 0 ? '–' : `${record.right} of ${record.resolved}`}</Stat>
        <Stat label="Brier" tip={brierTip(author)}>
          {record.brier === null ? '–' : record.brier.toFixed(2)}
          {record.marketBrier !== null && record.brier !== null && (
            <span className="text-sm font-normal text-muted-foreground"> market {record.marketBrier.toFixed(2)}</span>
          )}
        </Stat>
        <Stat label="In positions" tip="What their open positions are worth at Gemini's live prices.">
          {usd(author.portfolio.openValueUsd)}
        </Stat>
        <Stat label="Theses">{author.theses}</Stat>
        {isAgent && (
          <div className="flex items-end">
            <AgentLimits author={author} />
          </div>
        )}
        <Divider />
        <Stat label="Copiers" tip="People who have copied one of their theses.">
          {stats.copiers}
        </Stat>
        <Stat label="Tips earned" tip="Tips paid to them because a thesis turned out right.">
          {usdc(stats.tipsEarnedUsdc)} USDC
        </Stat>
        <Stat
          label="Tips held"
          tip="Tips in escrow on their open theses. Each goes to them only if that thesis is right, and back to the tipper otherwise."
        >
          {usdc(stats.tipsHeldUsdc)} USDC
        </Stat>
      </FigureRow>

      <div className="mt-10">
        <Tabs
          label={`${author.name}'s theses`}
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'open', label: 'Open theses', count: open.length },
            { key: 'resolved', label: 'Resolved', count: resolved.length },
          ]}
        />
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          <PositionList
            positions={tab === 'open' ? open : resolved}
            settled={tab === 'resolved'}
            prefix={() => null}
            empty={tab === 'open' ? 'No open theses right now.' : 'None have resolved yet.'}
          />
        </div>
      </div>
    </div>
  );
}
