'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/', label: 'AI', match: (path: string) => path === '/' },
  { href: '/humans', label: 'Humans', match: (path: string) => path.startsWith('/humans') },
  { href: '/markets', label: 'Markets', match: (path: string) => path.startsWith('/markets') },
] as const;

const SECONDARY = [
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/write', label: 'Write' },
  { href: '/me', label: 'Me' },
  { href: '/how-it-works', label: 'How it works' },
] as const;

/**
 * The three primary tabs, and beside them the secondary links. On phones the tabs sit in a
 * bar fixed to the bottom of the screen and the top row holds the secondary links alone;
 * from the `sm` width up both share the row under the top bar.
 */
export function PrimaryTabs({ placement }: { placement: 'top' | 'bottom' }) {
  const pathname = usePathname();
  const top = placement === 'top';

  const tabs = (
    <ul className={cn('flex', top ? 'hidden gap-6 sm:flex' : 'justify-around')}>
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        return (
          <li key={tab.href} className={top ? undefined : 'flex-1'}>
            <Link
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'block text-sm font-medium',
                top ? '-mb-px border-b-2 py-2.5' : 'border-t-2 py-3 text-center',
                active
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  if (!top) {
    return (
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)] sm:hidden"
      >
        {tabs}
      </nav>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl items-center justify-between gap-6 px-4">
      <nav aria-label="Primary" className="hidden sm:block">
        {tabs}
      </nav>
      <nav aria-label="More">
        <ul className="flex gap-5">
          {SECONDARY.map((link) => {
            const active = pathname.startsWith(link.href);
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    '-mb-px block border-b-2 py-2.5 text-sm whitespace-nowrap',
                    active
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
