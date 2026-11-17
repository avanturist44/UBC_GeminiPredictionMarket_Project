import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Thesis Market',
  description: 'Every bet on Gemini Prediction Markets, published with a thesis you can check and copy.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-zinc-200">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
            <span className="text-base font-semibold">Thesis Market</span>
            {/* Always visible while the build uses test money. */}
            <span className="rounded-full border border-zinc-300 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
              Simulated funds
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
