import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addComment,
  comments,
  countCommentsSince,
  createAuditingThesis,
  createGuestUser,
  ensureAgentAuthor,
  ensureHumanAuthor,
  eq,
  getFeed,
  getSocialCounts,
  getSparkPoints,
  likes,
  listComments,
  pricePoints,
  setLike,
  theses,
  trades,
  upsertMarket,
  type Db,
  type MarketUpsert,
} from '../src/index';
import { createTestDb } from '../src/testing';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

let seq = 0;
const uuid = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

const market = (symbol: string): MarketUpsert => ({
  instrumentSymbol: symbol,
  eventTicker: 'BTC2611192200',
  contractTicker: 'HI62250',
  title: 'BTC price on November 19',
  contractLabel: '$62,250 or above',
  category: 'Crypto',
  expiryAt: new Date('2026-11-19T22:00:00Z'),
  status: 'active',
  marketState: 'open',
  strike: '62250',
  yesBid: '0.76',
  yesAsk: '0.79',
  lastPrice: '0.78',
  keywords: [],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: null,
});

async function published(authorId: string, userId: string | null, symbol = `GEMI-S-${seq + 1}`) {
  const { id: marketId } = await upsertMarket(db, market(symbol));
  const id = uuid();
  await createAuditingThesis(db, {
    id,
    onchainId: `0xon${id}`,
    contentHash: `0xhash${id}`,
    authorId,
    userId,
    marketId,
    side: 'yes',
    probabilityYes: '0.85',
    headline: `Headline ${id.slice(-3)}`,
    body: 'Body',
    evidence: [{ claim: 'c', url: 'https://example.com' }],
    limitPrice: '0.80',
    quantity: '10',
    stakeUsd: '8',
  });
  await db
    .update(theses)
    .set({ status: 'published', publishedAt: new Date(`2026-11-19T0${seq % 10}:00:00Z`), entryPrice: '0.79' })
    .where(eq(theses.id, id));
  await db.update(trades).set({ status: 'filled' }).where(eq(trades.thesisId, id));
  return { id, marketId };
}

describe('likes', () => {
  it('counts one like per user, and liking twice or unliking twice changes nothing', async () => {
    const news = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const { id } = await published(news.id, null);
    const a = await createGuestUser(db, 'A');
    const b = await createGuestUser(db, 'B');
    expect(await setLike(db, id, a.id, true)).toEqual({ liked: true, likes: 1 });
    expect(await setLike(db, id, a.id, true)).toEqual({ liked: true, likes: 1 });
    expect(await setLike(db, id, b.id, true)).toEqual({ liked: true, likes: 2 });
    expect(await setLike(db, id, a.id, false)).toEqual({ liked: false, likes: 1 });
    expect(await setLike(db, id, a.id, false)).toEqual({ liked: false, likes: 1 });
    expect(await db.select().from(likes)).toHaveLength(1);
  });
});

describe('getSocialCounts', () => {
  it('counts likes, comments and filled copies per thesis, and marks what the viewer liked', async () => {
    const news = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const first = await published(news.id, null);
    const second = await published(news.id, null);
    const viewer = await createGuestUser(db, 'Viewer');
    const other = await createGuestUser(db, 'Other');
    await setLike(db, first.id, viewer.id, true);
    await setLike(db, first.id, other.id, true);
    await setLike(db, second.id, other.id, true);
    await addComment(db, { thesisId: first.id, userId: other.id, body: 'Strike looks safe to me.' });
    const copy = {
      marketId: first.marketId,
      thesisId: first.id,
      isAuthorPosition: false,
      side: 'yes' as const,
      quantity: '5',
      price: '0.79',
      costUsd: '3.95',
      mode: 'paper' as const,
    };
    await db.insert(trades).values([
      { ...copy, userId: viewer.id, status: 'filled', idempotencyKey: 'copy:1' },
      { ...copy, userId: other.id, status: 'settled', idempotencyKey: 'copy:2' },
      // A refused copy is not a copy.
      { ...copy, userId: other.id, status: 'rejected', idempotencyKey: 'copy:3' },
    ]);

    const counts = await getSocialCounts(db, [first.id, second.id], viewer.id);
    expect(counts.get(first.id)).toEqual({ likes: 2, comments: 1, copies: 2, liked: true });
    expect(counts.get(second.id)).toEqual({ likes: 1, comments: 0, copies: 0, liked: false });
    // Without a viewer nothing is marked as liked.
    expect((await getSocialCounts(db, [first.id], null)).get(first.id)?.liked).toBe(false);
    expect((await getSocialCounts(db, [], viewer.id)).size).toBe(0);
  });
});

describe('comments', () => {
  it('lists comments oldest first, names the commenter, and marks the thesis author', async () => {
    const authorUser = await createGuestUser(db, 'quietcarry');
    const author = await ensureHumanAuthor(db, authorUser);
    const { id } = await published(author.id, authorUser.id);
    const reader = await createGuestUser(db, 'fade_the_bounce');
    await addComment(db, { thesisId: id, userId: reader.id, body: 'What if it loses 63k overnight?' });
    const reply = await addComment(db, { thesisId: id, userId: authorUser.id, body: 'Then I said it is a coin flip.' });
    expect(reply).toMatchObject({ displayName: 'quietcarry', byAuthor: true, body: 'Then I said it is a coin flip.' });

    const list = await listComments(db, id);
    expect(list.map((c) => [c.displayName, c.byAuthor])).toEqual([
      ['fade_the_bounce', false],
      ['quietcarry', true],
    ]);
  });

  it('refuses an empty or overlong comment at the database too', async () => {
    const news = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const { id } = await published(news.id, null);
    const user = await createGuestUser(db, 'A');
    await expect(db.insert(comments).values({ thesisId: id, userId: user.id, body: '' })).rejects.toThrow();
    await expect(db.insert(comments).values({ thesisId: id, userId: user.id, body: 'x'.repeat(501) })).rejects.toThrow();
  });

  it('counts a user’s comments since a time, for the daily cap', async () => {
    const news = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const { id } = await published(news.id, null);
    const user = await createGuestUser(db, 'A');
    await addComment(db, { thesisId: id, userId: user.id, body: 'one' });
    await addComment(db, { thesisId: id, userId: user.id, body: 'two' });
    expect(await countCommentsSince(db, user.id, new Date(Date.now() - 60_000))).toBe(2);
    expect(await countCommentsSince(db, user.id, new Date(Date.now() + 60_000))).toBe(0);
  });
});

describe('getFeed with both kinds of author', () => {
  it('returns agents and people together when asked for all', async () => {
    const news = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const user = await createGuestUser(db, 'Sam');
    const person = await ensureHumanAuthor(db, user);
    await published(news.id, null);
    await published(person.id, user.id);
    expect(await getFeed(db, { kind: 'all' })).toHaveLength(2);
    expect(await getFeed(db, { kind: 'agent' })).toHaveLength(1);
    expect(await getFeed(db, { kind: 'human' })).toHaveLength(1);
  });
});

describe('getSparkPoints', () => {
  it('keeps the newest point in each slice of the window, and nothing outside it', async () => {
    const { id: marketId } = await upsertMarket(db, market('GEMI-SPARK'));
    const start = Date.parse('2026-11-19T00:00:00Z');
    // One point a minute for two hours.
    await db.insert(pricePoints).values(
      Array.from({ length: 120 }, (_, i) => ({
        marketId,
        ts: new Date(start + i * 60_000),
        yesBid: (0.5 + i / 1000).toFixed(4),
        yesAsk: (0.52 + i / 1000).toFixed(4),
        lastPrice: null,
        source: 'ws' as const,
      })),
    );
    const points = await getSparkPoints(
      db,
      { marketId, from: new Date(start + 30 * 60_000), to: new Date(start + 90 * 60_000) },
      12,
    );
    expect(points).toHaveLength(12);
    expect(points[0]!.ts.getTime()).toBeGreaterThanOrEqual(start + 30 * 60_000);
    expect(points.at(-1)!.ts.getTime()).toBe(start + 90 * 60_000);
    for (let i = 1; i < points.length; i += 1) expect(points[i]!.ts > points[i - 1]!.ts).toBe(true);
  });
});
