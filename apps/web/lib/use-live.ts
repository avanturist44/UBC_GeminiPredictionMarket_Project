'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import type { ApiError } from './market-view';

/** How often pages re-read live data. */
export const LIVE_REFRESH_MS = 5000;
export class ApiLoadError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (body as Partial<ApiError> | null)?.message;
    throw new ApiLoadError(message ?? `The request failed with status ${response.status}.`, response.status, (body as Partial<ApiError> | null)?.code);
  }
  return body as T;
}

/**
 * Live data from an API route: starts from what the server rendered, then re-reads every
 * five seconds. After a failed read the last good data stays on screen beside the error.
 */
export function useLive<T>(url: string, initial: T | undefined) {
  const { data, error, isValidating, mutate } = useSWR<T, ApiLoadError>(url, fetchJson, {
    fallbackData: initial,
    refreshInterval: LIVE_REFRESH_MS,
    keepPreviousData: true,
    revalidateOnFocus: true,
  });
  return { data, error, isValidating, retry: () => void mutate() };
}

/**
 * The current time, ticking once a second, for countdowns.
 *
 * The first render, on the server and again in the browser, uses `initial`: the time the
 * server read the data. Both then draw the same page even if a market closes in between or
 * the viewer's clock is off. After that it is the viewer's clock. `mounted` is false until
 * then: anything that depends on the viewer's time zone waits for it.
 */
export function useNow(initial: string | undefined): { now: Date; mounted: boolean } {
  const [state, setState] = useState(() => ({
    now: initial ? new Date(initial) : new Date(),
    mounted: false,
  }));
  useEffect(() => {
    const tick = () => setState({ now: new Date(), mounted: true });
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  return state;
}
