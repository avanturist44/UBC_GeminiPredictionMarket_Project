import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  audits,
  authorTradeKey,
  countAuditingTheses,
  countThesesSince,
  createAuditingThesis,
  createGuestUser,
  ensureAgentAuthor,
  ensureHumanAuthor,
  eq,
  getAuthorRecords,
  getFeed,
  getMarketBySymbol,
  getThesisView,
  getUserById,
  hasOpenThesis,
  llmTokensSince,
  recordLlmCall,
  theses,
  tips,
  trades,
  upsertMarket,
  type Db,
  type MarketUpsert,
  type NewThesis,
} from '../src/index';
import { createTestDb } from '../src/testing';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

const market = (overrides: Partial<MarketUpsert> = {}): MarketUpsert => ({
  instrumentSymbol: 'GEMI-BRENT2611182200-HI90',
  eventTicker: 'BRENT2611182200',
  contractTicker: 'HI90',
  title: 'Oil (Brent) price on November 18?',
  contractLabel: '$90 or above',
  category: 'Commodities',
  expiryAt: new Date('2026-11-18T22:00:00Z'),
  status: 'active',
  marketState: 'open',
  strike: '90',
  yesBid: '0.51',
  yesAsk: '0.55',
  lastPrice: '0.57',
  keywords: [],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: null,
  ...overrides,
});

let seq = 0;
const uuid = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

function newThesis(authorId: string, marketId: string, overrides: Partial<NewThesis> = {}): NewThesis {
  const id = uuid();
  return {
    id,
    onchainId: `0xon${id}`,
    contentHash: `0xhash${id}`,
    authorId,
    userId: null,
    marketId,
    side: 'yes',
    probabilityYes: '0.7',
    headline: `Headline ${id.slice(-3)}`,
    body: 'Body',
    evidence: [{ claim: 'c', url: 'https://example.com' }],
    limitPrice: '0.60',
    quantity: '9.09',
    stakeUsd: '5',
    ...overrides,
  };
}

async function publish(thesisId: string, at: Date, extra: Partial<typeof theses.$inferInsert> = {}) {
  await db
    .update(theses)
    .set({ status: 'published', publishedAt: at, entryPrice: '0.55', marketYesPriceAtPublish: '0.55', ...extra })
    .where(eq(theses.id, thesisId));
  await db.update(trades).set({ status: 'filled' }).where(eq(trades.thesisId, thesisId));
}

describe('users and authors', () => {
  it('creates a guest with the default paper balance, and finds them again', async () => {
    const user = await createGuestUser(db, 'Guest 4821');
    expect(user).toMatchObject({ displayName: 'Guest 4821', isGuest: true, paperBalanceUsd: '1000.0000' });
    expect(await getUserById(db, user.id)).toMatchObject({ id: user.id });
    expect(await getUserById(db, '00000000-0000-4000-8000-999999999999')).toBeNull();
  });

  it('gives a person one author record, however often it is asked for', async () => {
    const user = await createGuestUser(db, 'Sam');
    const first = await ensureHumanAuthor(db, user);
    const second = await ensureHumanAuthor(db, user);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ kind: 'human', userId: user.id, displayName: 'Sam' });
  });

  it('gives an agent one author record', async () => {
    const agent = { agentKey: 'news', displayName: 'News', strategySummary: 'Reads the news.' };
    const first = await ensureAgentAuthor(db, agent);
    expect((await ensureAgentAuthor(db, agent)).id).toBe(first.id);
    expect(first).toMatchObject({ kind: 'agent', agentKey: 'news', userId: null });
  });
});

describe('createAuditingThesis', () => {
  it('stores the thesis as auditing with its author’s trade as pending, and charges nothing', async () => {
    const user = await createGuestUser(db, 'Sam');
    const author = await ensureHumanAuthor(db, user);
    const { id: marketId } = await upsertMarket(db, market());
    const thesis = newThesis(author.id, marketId, { userId: user.id });
    await createAuditingThesis(db, thesis);

    const [stored] = await db.select().from(theses).where(eq(theses.id, thesis.id));
    expect(stored).toMatchObject({ status: 'auditing', publishedAt: null, entryPrice: null, side: 'yes' });
    const [trade] = await db.select().from(trades).where(eq(trades.thesisId, thesis.id));
    expect(trade).toMatchObject({
      userId: user.id,
      authorId: author.id,
      isAuthorPosition: true,
      status: 'pending',
      locked: true,
      price: '0.6000',
      costUsd: '5.0000',
      idempotencyKey: authorTradeKey(thesis.id),
    });
    expect((await getUserById(db, user.id))!.paperBalanceUsd).toBe('1000.0000');
    expect(await hasOpenThesis(db, author.id, marketId)).toBe(true);
    expect(await countAuditingTheses(db, author.id)).toBe(1);
  });

  it('refuses a second waiting thesis from the same author, whatever the application checked', async () => {
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const { id: brent } = await upsertMarket(db, market());
    const { id: gold } = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-XAU-X' }));
    await createAuditingThesis(db, newThesis(author.id, brent));
    // Same market, and another market: both are stopped by the database, and leave no trade.
    await expect(createAuditingThesis(db, newThesis(author.id, brent))).rejects.toThrow();
    await expect(createAuditingThesis(db, newThesis(author.id, gold))).rejects.toThrow();
    expect(await db.select().from(theses)).toHaveLength(1);
    expect(await db.select().from(trades)).toHaveLength(1);
  });

  it('refuses a thesis on a market where the author already has a public one', async () => {
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const { id: brent } = await upsertMarket(db, market());
    const first = newThesis(author.id, brent);
    await createAuditingThesis(db, first);
    await publish(first.id, new Date());
    await expect(createAuditingThesis(db, newThesis(author.id, brent))).rejects.toThrow();
    expect(await countThesesSince(db, author.id, new Date(Date.now() - 60_000))).toBe(1);
  });

  it('stores neither row if one fails', async () => {
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const { id: marketId } = await upsertMarket(db, market());
    // A headline over the limit fails the thesis; the trade must not be left behind.
    const bad = newThesis(author.id, marketId, { headline: 'x'.repeat(91) });
    await expect(createAuditingThesis(db, bad)).rejects.toThrow();
    expect(await db.select().from(theses)).toHaveLength(0);
    expect(await db.select().from(trades)).toHaveLength(0);
    expect(await hasOpenThesis(db, author.id, marketId)).toBe(false);
  });
});

describe('getMarketBySymbol', () => {
  it('finds a tracked market and nothing else', async () => {
    await upsertMarket(db, market());
    expect(await getMarketBySymbol(db, 'GEMI-BRENT2611182200-HI90')).toMatchObject({ strike: '90' });
    expect(await getMarketBySymbol(db, 'GEMI-NOPE-X')).toBeNull();
  });
});

describe('language-model usage', () => {
  it('adds up input and output tokens since a time', async () => {
    await recordLlmCall(db, { purpose: 'audit-screen', model: 'm', inputTokens: 1000, outputTokens: 200 });
    await recordLlmCall(db, { purpose: 'news', model: 'm', inputTokens: 5000, outputTokens: 800 });
    expect(await llmTokensSince(db, new Date(Date.now() - 60_000))).toBe(7000);
    expect(await llmTokensSince(db, new Date(Date.now() + 60_000))).toBe(0);
  });
});

describe('feeds and the thesis view', () => {
  async function seed() {
    const sam = await createGuestUser(db, 'Sam');
    const human = await ensureHumanAuthor(db, sam);
    const news = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const fade = await ensureAgentAuthor(db, { agentKey: 'fade', displayName: 'Fade', strategySummary: 's' });
    const { id: brent } = await upsertMarket(db, market());
    const { id: gold } = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-XAU-X', title: 'Gold' }));
    return { sam, human, news, fade, brent, gold };
  }

  it('lists public theses of one kind, newest first, and leaves out drafts, auditing and blocked', async () => {
    const { human, news, fade, brent, gold } = await seed();
    const a = newThesis(news.id, brent);
    const b = newThesis(fade.id, brent);
    const c = newThesis(news.id, gold);
    const waiting = newThesis(fade.id, gold);
    const person = newThesis(human.id, brent);
    // An author has one thesis with the auditor at a time, so each is published before the next.
    await createAuditingThesis(db, a);
    await publish(a.id, new Date('2026-11-18T03:00:00Z'));
    await createAuditingThesis(db, b);
    await publish(b.id, new Date('2026-11-18T05:00:00Z'));
    await createAuditingThesis(db, c);
    await publish(c.id, new Date('2026-11-18T04:00:00Z'), { status: 'resolved', outcome: 'right' });
    await createAuditingThesis(db, person);
    await publish(person.id, new Date('2026-11-18T06:00:00Z'));
    await createAuditingThesis(db, waiting);

    const feed = await getFeed(db, { kind: 'agent' });
    expect(feed.map((v) => v.thesis.id)).toEqual([b.id, c.id, a.id]);
    expect(feed[0]).toMatchObject({
      author: { agentKey: 'fade', kind: 'agent' },
      market: { instrumentSymbol: 'GEMI-BRENT2611182200-HI90' },
      position: { status: 'filled', isAuthorPosition: true },
      audit: null,
      tipsUsdc: '0',
    });
    expect((await getFeed(db, { kind: 'human' })).map((v) => v.thesis.id)).toEqual([person.id]);
    expect((await getFeed(db, { kind: 'agent', agentKey: 'news' })).map((v) => v.thesis.id)).toEqual([c.id, a.id]);
  });

  it('pages back in time with a cursor', async () => {
    const { news, brent, gold } = await seed();
    const a = newThesis(news.id, brent);
    const b = newThesis(news.id, gold);
    await createAuditingThesis(db, a);
    await publish(a.id, new Date('2026-11-18T03:00:00Z'));
    await createAuditingThesis(db, b);
    await publish(b.id, new Date('2026-11-18T05:00:00Z'));
    const first = await getFeed(db, { kind: 'agent', limit: 1 });
    expect(first.map((v) => v.thesis.id)).toEqual([b.id]);
    const next = await getFeed(db, { kind: 'agent', limit: 1, before: first[0]!.thesis.publishedAt! });
    expect(next.map((v) => v.thesis.id)).toEqual([a.id]);
  });

  it('attaches the newest audit and the tips held for the thesis', async () => {
    const { sam, news, brent } = await seed();
    const thesis = newThesis(news.id, brent);
    await createAuditingThesis(db, thesis);
    await publish(thesis.id, new Date('2026-11-18T03:00:00Z'));
    await db.insert(audits).values({ thesisId: thesis.id, verdict: 'pass', model: 'old', createdAt: new Date('2026-11-18T02:00:00Z') });
    await db.insert(audits).values({
      thesisId: thesis.id,
      verdict: 'flagged',
      model: 'new',
      claims: [{ text: 'c', status: 'contradicted', source_url: null, note: 'n' }],
      createdAt: new Date('2026-11-18T02:30:00Z'),
    });
    await db.insert(tips).values([
      { thesisId: thesis.id, userId: sam.id, amountUsdc: '0.25', status: 'escrowed' },
      { thesisId: thesis.id, userId: sam.id, amountUsdc: '0.50', status: 'paid' },
      { thesisId: thesis.id, userId: sam.id, amountUsdc: '0.10', status: 'failed' },
    ]);

    const view = await getThesisView(db, thesis.id);
    expect(view!.audit).toMatchObject({ verdict: 'flagged', model: 'new' });
    expect(view!.audit!.claims).toHaveLength(1);
    expect(Number(view!.tipsUsdc)).toBe(0.75);
  });

  it('returns a thesis that is not public too, with no position once its trade is rejected', async () => {
    const { news, brent } = await seed();
    const thesis = newThesis(news.id, brent);
    await createAuditingThesis(db, thesis);
    expect((await getThesisView(db, thesis.id))!.position).toMatchObject({ status: 'pending' });
    await db.update(theses).set({ status: 'blocked' }).where(eq(theses.id, thesis.id));
    await db.update(trades).set({ status: 'rejected' }).where(eq(trades.thesisId, thesis.id));
    const view = await getThesisView(db, thesis.id);
    expect(view).toMatchObject({ thesis: { status: 'blocked' }, position: null });
    expect(await getThesisView(db, '00000000-0000-4000-8000-999999999999')).toBeNull();
  });
});

describe('getAuthorRecords', () => {
  it('scores resolved theses with the Brier score, and the market on the same theses', async () => {
    const author = await ensureAgentAuthor(db, { agentKey: 'news', displayName: 'News', strategySummary: 's' });
    const other = await ensureAgentAuthor(db, { agentKey: 'fade', displayName: 'Fade', strategySummary: 's' });
    const cases: Array<[side: 'yes' | 'no', p: string, mkt: string, outcome: 'right' | 'wrong' | 'void']> = [
      // YES at 80%, YES won: (0.8 - 1)^2 = 0.04. Market 0.6: 0.16.
      ['yes', '0.8', '0.6', 'right'],
      // NO with YES at 30%, YES lost: (0.3 - 0)^2 = 0.09. Market 0.5: 0.25.
      ['no', '0.3', '0.5', 'right'],
      // YES at 70%, YES lost: 0.49. Market 0.6: 0.36.
      ['yes', '0.7', '0.6', 'wrong'],
      // Void: ignored.
      ['yes', '0.9', '0.5', 'void'],
    ];
    for (const [i, [side, p, mkt, outcome]] of cases.entries()) {
      const { id: marketId } = await upsertMarket(db, market({ instrumentSymbol: `GEMI-R-${i}` }));
      const thesis = newThesis(author.id, marketId, { side, probabilityYes: p });
      await createAuditingThesis(db, thesis);
      await publish(thesis.id, new Date(), { status: 'resolved', outcome, marketYesPriceAtPublish: mkt });
    }
    const records = await getAuthorRecords(db, [author.id, other.id]);
    expect(records.get(author.id)).toEqual({
      resolved: 3,
      right: 2,
      brier: 0.2067, // (0.04 + 0.09 + 0.49) / 3
      marketBrier: 0.2567, // (0.16 + 0.25 + 0.36) / 3
    });
    expect(records.has(other.id)).toBe(false);
  });

  it('scores a constant 50% forecast at 0.25', async () => {
    const author = await ensureAgentAuthor(db, { agentKey: 'coin', displayName: 'Coin', strategySummary: 's' });
    for (const [i, outcome] of (['right', 'wrong'] as const).entries()) {
      const { id: marketId } = await upsertMarket(db, market({ instrumentSymbol: `GEMI-C-${i}` }));
      const thesis = newThesis(author.id, marketId, { probabilityYes: '0.5' });
      await createAuditingThesis(db, thesis);
      await publish(thesis.id, new Date(), { status: 'resolved', outcome });
    }
    expect((await getAuthorRecords(db, [author.id])).get(author.id)).toMatchObject({ resolved: 2, brier: 0.25 });
  });
});
