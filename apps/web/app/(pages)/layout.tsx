import type { ReactNode } from 'react';

/** Every page except Home: one reading column. */
export default function PagesLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6 lg:pt-8">{children}</div>;
}
