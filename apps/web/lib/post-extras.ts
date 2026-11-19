import 'server-only';
import { windowOpensAt } from '@thesis/core';
import { getSocialCounts, getSparkPoints, type Db, type SocialCounts, type ThesisView } from '@thesis/db';
import { sparkWindow, toSpark } from './spark';
import type { SparkView } from './thesis-view';

/**
 * What a post shows beyond the thesis itself: likes, comments, copies, and its odds line.
 * The lines are cached for a few seconds per server instance: the feed is re-read every five
 * seconds by every open page, and a line drawn from 48 points does not change that fast.
 */

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; spark: SparkView | null }>();

async function sparkFor(db: Db, view: ThesisView, now: Date): Promise<SparkView | null> {
  const { thesis, market } = view;
  const window = sparkWindow({
    publishedAt: thesis.publishedAt,
    expiryAt: market.expiryAt,
    opensAt: windowOpensAt(market.eventTicker, market.expiryAt),
    now,
  });
  if (!window) return null;
  // Rounded so that every page asking in the same few seconds shares one entry.
  const bucket = Math.floor(window.to.getTime() / CACHE_MS);
  const key = `${thesis.id}:${bucket}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.spark;
  const points = await getSparkPoints(db, { marketId: market.id, ...window });
  const spark = toSpark(points, {
    side: thesis.side,
    entryPrice: thesis.entryPrice,
    publishedAt: thesis.publishedAt,
    ...window,
  });
  cache.set(key, { at: now.getTime(), spark });
  if (cache.size > 1000) cache.clear();
  return spark;
}

export interface PostExtras {
  social: Map<string, SocialCounts>;
  sparks: Map<string, SparkView | null>;
}

export async function loadPostExtras(
  db: Db,
  views: readonly ThesisView[],
  viewerUserId: string | null,
  now = new Date(),
): Promise<PostExtras> {
  const ids = views.map((view) => view.thesis.id);
  const [social, sparkList] = await Promise.all([
    getSocialCounts(db, ids, viewerUserId),
    // A failed line is drawn as no line; it never fails the feed.
    Promise.all(views.map((view) => sparkFor(db, view, now).catch(() => null))),
  ]);
  return { social, sparks: new Map(views.map((view, i) => [view.thesis.id, sparkList[i] ?? null])) };
}
