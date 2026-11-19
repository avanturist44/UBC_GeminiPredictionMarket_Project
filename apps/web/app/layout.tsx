import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import { BottomNav, SideNav, TopBar } from '@/components/app-nav';
import { LiveStrip } from '@/components/live-strip';
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

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0f0f10', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={plex.variable}>
      <body>
        <div className="lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
          <SideNav />
          <div className="min-w-0">
            <TopBar />
            <LiveStrip />
            {/* The bottom padding keeps content clear of the phone tab bar. */}
            <main className="pb-24 lg:pb-12">{children}</main>
          </div>
        </div>
        <BottomNav />
      </body>
    </html>
  );
}
