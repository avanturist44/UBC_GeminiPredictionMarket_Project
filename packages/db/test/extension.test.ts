import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authors,
  eq,
  getExtensionCard,
  listExtensionMarkets,
  markets,
  theses,
  upsertMarket,
  users,
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

const NOW = new Date('2026-11-18T03:05:00Z');

const market = (overrides: Partial<MarketUpsert> = {}): MarketUpsert => ({
  instrumentSymbol: 'GEMI-BTC15M2611180315-UP',
  eventTicker: 'BTC15M2611180315',
  contractTicker: 'UP',
  title: 'BTC price today at 10:15pm EST',
  contractLabel: 'Up',
  category: 'Crypto',
  expiryAt: new Date('2026-11-18T03:15:00Z'),
  status: 'active',
  marketState: 'open',
  strike: '64931.38',
  yesBid: '0.40',
  yesAsk: '0.50',
  lastPrice: '0.45',
  keywords: [['bitcoin'], ['btc']],
  quantityIncrement: '0.01',
  quantityMinimum: '0.01',
  priceIncrement: '0.01',
  sourceDetails: null,
  ...overrides,
});

let seq = 0;
async function agent(): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(authors)
    .values({ kind: 'agent', agentKey: `agent-${seq}`, displayName: `Agent ${seq}` })
    .returning();
  return row!.id;
}

async function human(): Promise<string> {
  seq += 1;
  const [user] = await db.insert(users).values({ displayName: `Person ${seq}` }).returning();
  const [row] = await db
    .insert(authors)
    .values({ kind: 'human', userId: user!.id, displayName: `Person ${seq}` })
    .returning();
  return row!.id;
}

async function thesis(
  marketId: string,
  authorId: string,
  overrides: Partial<typeof theses.$inferInsert> = {},
) {
  seq += 1;
  const [row] = await db
    .insert(theses)
    .values({
      onchainId: `0xext${seq}`,
      authorId,
      marketId,
      side: 'yes',
      probabilityYes: '0.6',
      headline: `Headline ${seq}`,
      body: `Body ${seq}`,
      entryPrice: '0.5',
      status: 'published',
      publishedAt: new Date('2026-11-18T03:00:00Z'),
      ...overrides,
    })
    .returning();
  return row!;
}

describe('listExtensionMarkets', () => {
  it('lists open tracked markets with keywords, most public theses first', async () => {
    const quiet = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-QUIET' }));
    const busy = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-BUSY', expiryAt: null }));
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-EXPIRED', expiryAt: new Date('2026-11-18T03:00:00Z') }));
    await upsertMarket(db, market({ instrumentSymbol: 'GEMI-NOKEYWORDS', keywords: [] }));
    const untracked = await upsertMarket(db, market({ instrumentSymbol: 'GEMI-UNTRACKED' }));
    await db.update(markets).set({ tracked: false }).where(eq(markets.id, untracked.id));

    await thesis(busy.id, await agent());
    await thesis(busy.id, await human());
    // Not public, so not counted.
    await thesis(quiet.id, await agent(), { status: 'blocked', publishedAt: null });

    expect(await listExtensionMarkets(db, NOW)).toEqual([
      {
        instrumentSymbol: 'GEMI-BUSY',
        title: 'BTC price today at 10:15pm EST',
        contractLabel: 'Up',
        keywords: [['bitcoin'], ['btc']],
        theses: 2,
      },
      {
        instrumentSymbol: 'GEMI-QUIET',
        title: 'BTC price today at 10:15pm EST',
        contractLabel: 'Up',
        keywords: [['bitcoin'], ['btc']],
        theses: 0,
      },
    ]);
  });
});

describe('getExtensionCard', () => {
  it('returns null for a symbol that is not tracked', async () => {
    expect(await getExtensionCard(db, 'GEMI-NOPE')).toBeNull();
  });

  it('returns the quote and the public theses, newest first, with each author’s record', async () => {
    const { id } = await upsertMarket(db, market());
    const seasoned = await agent();
    // Three resolved theses elsewhere give the agent a record: two right, one wrong.
    for (const [i, outcome] of (['right', 'right', 'wrong'] as const).entries()) {
      const other = await upsertMarket(db, market({ instrumentSymbol: `GEMI-OLD-${i}` }));
      await thesis(other.id, seasoned, { status: 'resolved', outcome, probabilityYes: '0.7' });
    }
    const older = await thesis(id, seasoned, { publishedAt: new Date('2026-11-18T02:00:00Z') });
    const newer = await thesis(id, await human(), { side: 'no', probabilityYes: '0.3', entryPrice: null });
    await thesis(id, await human(), { status: 'auditing', publishedAt: null });

    const card = await getExtensionCard(db, 'GEMI-BTC15M2611180315-UP');
    expect(card?.market).toEqual({
      instrumentSymbol: 'GEMI-BTC15M2611180315-UP',
      title: 'BTC price today at 10:15pm EST',
      contractLabel: 'Up',
      yesBid: '0.4000',
      yesAsk: '0.5000',
      lastPrice: '0.4500',
    });
    expect(card?.theses.map((t) => t.id)).toEqual([newer.id, older.id]);
    expect(card?.theses[0]).toMatchObject({ side: 'no', entryPrice: null, authorKind: 'human' });
    expect(card?.theses[0]!.record).toEqual({ resolved: 0, right: 0, brier: null, marketBrier: null });
    expect(card?.theses[1]).toMatchObject({ authorKind: 'agent', authorName: expect.stringMatching(/^Agent/) });
    expect(card?.theses[1]!.record).toMatchObject({ resolved: 3, right: 2 });
    expect(card?.theses[1]!.record.brier).not.toBeNull();
  });
});
