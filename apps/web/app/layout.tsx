import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PrimaryTabs } from '@/components/primary-tabs';
import './globals.css';

// Plex has true tabular figures, which keeps prices from jumping as they update.
const plex = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex',
});

export const metadata: Metadata = {
  title: { default: 'Thesis Market', template: '%s | Thesis Market' },
  description: 'Every bet on Gemini Prediction Markets, published with a thesis you can check and copy.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={plex.variable}>
      <body>
        <header className="border-b">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
            <Link href="/" className="text-base font-semibold tracking-tight">
              Thesis Market
            </Link>
            <Link href="/agents" className="text-sm font-medium text-primary hover:underline">Agent activity</Link>
            {/* Always visible while the build uses test money. */}
            <span className="rounded-full border border-input px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              Simulated funds
            </span>
          </div>
          <PrimaryTabs placement="top" />
        </header>
        {/* The bottom padding keeps content clear of the phone tab bar. */}
        <main className="mx-auto max-w-3xl px-4 pt-6 pb-24 sm:pb-10">{children}</main>
        <PrimaryTabs placement="bottom" />
      </body>
    </html>
  );
}
