'use client';

import { ChartLine, CircleHelp, CircleUser, House, PenLine, Plus, Trophy, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AccountChip } from '@/components/account-chip';
import { cn } from '@/lib/utils';

/**
 * Navigation. From the `lg` width a sidebar holds every destination; below it a top bar holds
 * the name and the balance, and a tab bar at the bottom holds the destinations a thumb needs.
 */

interface Destination {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (path: string) => boolean;
}

const HOME: Destination = {
  href: '/',
  label: 'Home',
  icon: House,
  match: (p) => p === '/' || p.startsWith('/thesis') || p.startsWith('/humans'),
};
const MARKETS: Destination = { href: '/markets', label: 'Markets', icon: ChartLine, match: (p) => p.startsWith('/markets') };
const LEADERBOARD: Destination = {
  href: '/leaderboard',
  label: 'Leaderboard',
  icon: Trophy,
  match: (p) => p.startsWith('/leaderboard') || p.startsWith('/authors'),
};
const ME: Destination = { href: '/me', label: 'Me', icon: CircleUser, match: (p) => p.startsWith('/me') };
const HOW: Destination = { href: '/how-it-works', label: 'How it works', icon: CircleHelp, match: (p) => p.startsWith('/how-it-works') };

/**
 * The name is the mark: convíx, said like conviction. The accent on the í is drawn as a
 * notched arrowhead pointing up and to the right, over a dotless ı, in the letters' own
 * color. Its size and place are in em, so it scales with the name.
 */
export function Wordmark() {
  return (
    <Link href="/" aria-label="convíx, home" className="inline-flex items-center rounded-md">
      <span aria-hidden className="serif-title text-[24px] leading-none">
        conv
        <span className="relative inline-block">
          ı
          <svg
            viewBox="0 0 100 100"
            className="absolute bottom-[0.66em] left-[calc(50%-0.13em)] size-[0.28em] overflow-visible"
          >
            <polygon points="92,18 51,71 56,43 28,38" fill="currentColor" />
          </svg>
        </span>
        x
      </span>
    </Link>
  );
}

export function SimulatedBadge() {
  return (
    <span className="rounded-md border border-input px-2 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground">
      Simulated funds
    </span>
  );
}

export function SideNav() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border px-4 py-5 lg:flex">
      <div className="px-2">
        <Wordmark />
      </div>
      <nav aria-label="Main" className="mt-8">
        <ul className="space-y-1">
          {[HOME, MARKETS, LEADERBOARD, ME, HOW].map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-10 items-center gap-3 rounded-lg px-3 text-[15px] transition-colors',
                    active
                      ? 'bg-secondary font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                  )}
                >
                  <Icon aria-hidden className="size-[18px]" strokeWidth={1.75} />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <Link
          href="/write"
          className="mt-6 flex h-10 items-center justify-center gap-2 rounded-lg bg-primary text-[15px] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
        >
          <PenLine aria-hidden className="size-4" strokeWidth={2} />
          Write a thesis
        </Link>
      </nav>
      <div className="mt-auto space-y-3 px-2">
        <SimulatedBadge />
        <AccountChip layout="stacked" />
      </div>
    </aside>
  );
}

export function TopBar() {
  return (
    <header className="flex h-14 items-center gap-3 border-b border-border px-4 lg:hidden">
      <Wordmark />
      <div className="ml-auto flex items-center gap-3">
        <SimulatedBadge />
        <AccountChip layout="inline" />
      </div>
    </header>
  );
}

export function BottomNav() {
  const pathname = usePathname();
  const slot = (item: Destination) => {
    const active = item.match(pathname);
    const Icon = item.icon;
    return (
      <li key={item.href} className="flex-1">
        <Link
          href={item.href}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'relative flex h-14 flex-col items-center justify-center gap-1 text-[11px] transition-colors',
            active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {active && <span aria-hidden className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-primary" />}
          <Icon aria-hidden className="size-5" strokeWidth={active ? 2 : 1.75} />
          {item.label}
        </Link>
      </li>
    );
  };
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="mx-auto flex max-w-xl items-stretch">
        {slot(HOME)}
        {slot(MARKETS)}
        <li className="flex flex-1 items-center justify-center">
          <Link
            href="/write"
            aria-label="Write a thesis"
            aria-current={pathname.startsWith('/write') ? 'page' : undefined}
            className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,transform] hover:bg-primary/85 active:scale-[0.97]"
          >
            <Plus aria-hidden className="size-5" strokeWidth={2.25} />
          </Link>
        </li>
        {slot(LEADERBOARD)}
        {slot(ME)}
      </ul>
    </nav>
  );
}
