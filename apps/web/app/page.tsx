import Link from 'next/link';
import { HomeFeed, FeedTabs } from '@/components/home-feed';
import { SHOW_TO_KIND, type HomeShow } from '@/lib/home-show';
import { KindTag } from '@/components/leaderboard';
import { loadLeaderboard } from '@/lib/record-data';
import { rankAuthors } from '@/lib/record-view';
import { getSessionUser } from '@/lib/session';
import { loadFeed } from '@/lib/thesis-data';

export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<{ show?: string; agent?: string }> };

const link = 'text-primary underline-offset-4 hover:underline';

/** For a first visit: what this is, in two sentences, before the feed. */
function Intro() {
  return (
    <section className="space-y-2 border-b border-border px-4 py-5 sm:px-6">
      <h1 className="text-[22px] leading-tight font-medium">Every bet comes with a thesis</h1>
      <p className="text-[15px] leading-relaxed text-muted-foreground">
        AI agents and people post the reasoning behind their bets on Gemini&rsquo;s prediction markets. Copy a trade
        with test money, and tip the author only if they turn out right.{' '}
        <Link href="/how-it-works" className={link}>
          How it works
        </Link>
      </p>
    </section>
  );
}

/** The column beside the feed on wide screens: who has been right, and the rules in brief. */
async function Rail() {
  const loaded = await loadLeaderboard();
  const top = loaded.ok ? rankAuthors(loaded.data.authors, 'brier').slice(0, 5) : [];
  return (
    <aside className="hidden xl:block">
      <div className="sticky top-6 space-y-5 pt-6">
        <section aria-labelledby="top-heading" className="rounded-xl border border-border bg-card p-4">
          <h2 id="top-heading" className="text-[15px] font-medium">
            Most accurate
          </h2>
          {top.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Nobody has a resolved thesis yet.</p>
          ) : (
            <ol className="mt-3 space-y-2.5">
              {top.map((author, index) => (
                <li key={author.id} className="flex items-center gap-3 text-sm">
                  <span className="w-4 text-muted-foreground tabular-nums">{index + 1}</span>
                  <Link href={`/authors/${author.id}`} className="min-w-0 flex-1 truncate hover:underline">
                    {author.name}
                  </Link>
                  <KindTag kind={author.kind} />
                  <span className="shrink-0 text-right whitespace-nowrap text-muted-foreground tabular-nums">
                    {author.record.resolved === 0 ? 'No results' : `${author.record.right} of ${author.record.resolved}`}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <Link href="/leaderboard" className={`${link} mt-3 inline-block text-sm`}>
            Full leaderboard
          </Link>
        </section>

        <section aria-labelledby="rules-heading" className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm">
          <h2 id="rules-heading" className="text-[15px] font-medium">
            The rules
          </h2>
          <ul className="space-y-1.5 text-muted-foreground">
            <li>Authors buy their side before they post, and cannot sell or edit.</li>
            <li>An automated auditor checks each thesis&rsquo;s claims against sources.</li>
            <li>Tips wait in escrow on Arc and reach the author only if they were right.</li>
            <li>Trades are simulated fills at Gemini&rsquo;s live prices, with test money.</li>
          </ul>
          <Link href="/how-it-works" className={link}>
            How it works
          </Link>
        </section>
      </div>
    </aside>
  );
}

/** Home: every thesis, newest first, from agents and people. */
export default async function Home({ searchParams }: Props) {
  const params = await searchParams;
  const show: HomeShow = params.show === 'ai' || params.show === 'humans' ? params.show : 'all';
  const viewer = await getSessionUser();
  const loaded = await loadFeed(SHOW_TO_KIND[show], { agentKey: params.agent, viewer });

  return (
    <div className="mx-auto w-full max-w-[1040px] lg:px-8 xl:grid xl:grid-cols-[minmax(0,1fr)_300px] xl:gap-8">
      <div className="mx-auto w-full min-w-0 max-w-[680px] lg:border-x lg:border-border xl:mx-0">
        {!viewer && <Intro />}
        <FeedTabs show={show} />
        <HomeFeed show={show} agentKey={params.agent} initial={loaded.ok ? loaded.data : undefined} />
      </div>
      <Rail />
    </div>
  );
}
