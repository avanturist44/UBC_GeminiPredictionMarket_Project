import type { FeedKind } from './thesis-view';

/**
 * Which theses the home feed shows. Plain data with no 'use client', so the server page and
 * the client feed both read the real values. A value exported from a 'use client' module
 * reaches a server component only as a client reference, and reading it there gives
 * `undefined`.
 */
export type HomeShow = 'all' | 'ai' | 'humans';

export const SHOW_TO_KIND: Record<HomeShow, FeedKind> = { all: 'all', ai: 'agent', humans: 'human' };
