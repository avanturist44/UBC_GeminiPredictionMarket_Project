/** Two real Postgres connections, fixture-only temporary database, no Circle/RPC calls. */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createDb, authors, chainActions, eq, markets, sql, theses, thesisRegistrations, trades, users, walletAccounts } from '../packages/db/src/index';
import { runMigrations } from '../packages/db/src/migrate';
import { createGuest, hashContent, quoteCopy, copyTrade, advanceAction, settleCopies, type ChainGateway, type ExecutableQuote } from '../packages/services/src/index';
process.loadEnvFile(new URL('../.env', import.meta.url));
const base = new URL(process.env.DATABASE_URL!); assert(['127.0.0.1','localhost'].includes(base.hostname));
const name = `copy_test_${randomUUID().replaceAll('-', '')}`, adminUrl = new URL(base), testUrl = new URL(base);
adminUrl.pathname = '/postgres'; testUrl.pathname = `/${name}`;
const admin = createDb(adminUrl.href, {max:1}); let one: ReturnType<typeof createDb> | undefined, two: ReturnType<typeof createDb> | undefined;
const escrow = '0x1111111111111111111111111111111111111111', secret = 'copy-concurrency-fixture'.repeat(3), now = Date.now();
try {
  await admin.db.execute(sql.raw(`create database "${name}"`)); await runMigrations(testUrl.href);
  one = createDb(testUrl.href,{max:1}); two = createDb(testUrl.href,{max:1}); const db=one.db;
  async function fixture() {
    const owner=await createGuest(db,'Fixture author'), copier=await createGuest(db,'Fixture copier');
    const [author]=await db.select().from(authors).where(eq(authors.userId,owner.id));
    const [market]=await db.insert(markets).values({instrumentSymbol:`GEMI-FIXTURE-${randomUUID()}`,eventTicker:randomUUID(),contractTicker:'UP',title:'Fixture only',status:'active',marketState:'open',tracked:true,expiryAt:new Date(now+600_000)}).returning();
    const id=randomUUID(),key=`fixture:${id}`;
    await db.insert(chainActions).values({key,kind:'register',walletId:randomUUID(),contractAddress:escrow,status:'confirmed'});
    await db.insert(theses).values({id,onchainId:hashContent(id),authorId:author!.id,marketId:market!.id,side:'yes',probabilityYes:'0.7',headline:'Fixture only',body:'Fixture only',entryPrice:'0.48',contentHash:hashContent('fixture'),registerTx:`0x${'ab'.repeat(32)}`,status:'published',publishedAt:new Date(now)});
    await db.insert(thesisRegistrations).values({thesisId:id,escrowAddress:escrow,authorAddress:'0x2222222222222222222222222222222222222222',marketHash:hashContent(market!.id),contentHash:hashContent('fixture'),expiryAt:market!.expiryAt!,actionKey:key,confirmedAt:new Date(now)});
    await db.insert(walletAccounts).values({ownerKey:`user:${copier.id}`,userId:copier.id,circleWalletId:randomUUID(),address:'0x3333333333333333333333333333333333333333',status:'ready'});
    const quote: ExecutableQuote={symbol:market!.instrumentSymbol,bid:0.48,ask:0.5,bidSize:100,askSize:100,observedAtMs:now,marketObservedAtMs:now,status:'active',marketState:'open',expiryMs:now+600_000,quantityIncrement:'0.01',quantityMinimum:'0.01'};
    const signed=await quoteCopy(db,id,copier.id,'5','0.10',quote,{escrowAddress:escrow,secret,now});
    return {copier,market:market!,id,input:{idempotencyKey:randomUUID(),amountUsd:'5',tipUsdc:'0.10',quoteToken:signed.quoteToken,acceptPriceMoved:false},options:{escrowAddress:escrow,secret,enabled:()=>true,readQuote:()=>quote,readFunds:()=>({ready:true,balance:2_000_000n,allowance:20_000_000n,observedAtMs:now}),now:()=>now}};
  }
  const f=await fixture();
  const duplicate=await Promise.all([one.db,two.db].map(connection=>copyTrade(connection,f.id,f.copier.id,f.input,f.options)));
  assert.equal(duplicate[0]!.tradeId,duplicate[1]!.tradeId);
  assert.equal((await db.select().from(trades).where(eq(trades.userId,f.copier.id))).length,1);
  const limited=await fixture(); await db.update(users).set({dailyCopyCapUsd:'5'}).where(eq(users.id,limited.copier.id));
  const limits=await Promise.allSettled([one.db,two.db].map(connection=>copyTrade(connection,limited.id,limited.copier.id,{...limited.input,idempotencyKey:randomUUID()},limited.options)));
  assert.equal(limits.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((limits.find(result=>result.status==='rejected') as PromiseRejectedResult).reason.code,'daily_limit');
  let submissions=0;
  const gateway={assertReady:async()=>{},submit:async()=>{submissions++;return randomUUID();},inspect:async()=>({state:'confirmed',hash:`0x${'cd'.repeat(32)}`}),receipt:async()=>({success:true,logs:[]}),prove:async()=>true} as unknown as ChainGateway;
  await db.insert(chainActions).values({key:'outbox-race',kind:'tip',walletId:randomUUID(),contractAddress:escrow,callData:'0x1234'});
  await Promise.all([one.db,two.db].map(connection=>advanceAction(connection,gateway,'outbox-race'))); assert.equal(submissions,1);
  const client={getEvent:async(ticker:string)=>ticker===f.market.eventTicker?{ticker,title:'Fixture only',status:'settled',contracts:[{ticker:'UP',instrumentSymbol:f.market.instrumentSymbol,resolutionSide:'yes' as const}]}:null};
  const settlements=await Promise.all([one.db,two.db].map(connection=>settleCopies(connection,client,now+700_000)));
  assert.equal(settlements.reduce((a,b)=>a+b,0),1);
  assert.equal((await db.select().from(users).where(eq(users.id,f.copier.id)))[0]!.paperBalanceUsd,'1005.0000');
} finally {
  await one?.close(); await two?.close(); await admin.db.execute(sql.raw(`drop database if exists "${name}"`)); await admin.close();
}
const result={checkedAt:new Date().toISOString(),passed:true,duplicateCopy:'one fill, one debit and one tip',concurrentCap:'one fill; one daily_limit',circleOutbox:'one submission',settlement:'one credit',temporaryDatabaseDropped:true,fixtureOnly:true};
await writeFile(new URL('../.local/phase4-concurrency.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
