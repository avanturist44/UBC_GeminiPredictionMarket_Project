'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/', label: 'AI', match: (path: string) => path === '/' || path.startsWith('/agents') },
  { href: '/humans', label: 'Humans', match: (path: string) => path.startsWith('/humans') },
  { href: '/markets', label: 'Markets', match: (path: string) => path.startsWith('/markets') },
] as const;

/**
 * The three primary tabs. On phones they sit in a bar fixed to the bottom of the screen;
 * from the `sm` width up they sit under the top bar. Both are rendered and CSS shows one.
 */
export function PrimaryTabs({ placement }: { placement: 'top' | 'bottom' }) {
  const pathname = usePathname();
  const top = placement === 'top';

  return (
    <nav
      aria-label="Primary"
      className={cn(
        top
          ? 'mx-auto hidden max-w-3xl px-4 sm:block'
          : 'fixed inset-x-0 bottom-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)] sm:hidden',
      )}
    >
      <ul className={cn('flex', top ? 'gap-6' : 'justify-around')}>
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
    </nav>
  );
}
