import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { authors, eq, markets, theses, tips, trades, users, type Db } from '@thesis/db';
import { createTestDb } from '../../db/src/testing';
import { createGuest, hashContent } from '../src/publication';
import { authorProfile, authorRecords, escrowActivity, leaderboard } from '../src/records';
import { changeLimits, effectiveLimits, getAccount, LimitsInput } from '../src/account';
let db: Db, close: () => Promise<void>;
const now = Date.parse('2026-11-19T23:59:00Z'), midnight = Date.parse('2026-11-20T00:00:00Z');
beforeAll(async () => { ({ db, close } = await createTestDb()); }); afterAll(() => close());
async function author() { const user=await createGuest(db,'Records fixture'); const [record]=await db.select().from(authors).where(eq(authors.userId,user.id));return {user,record:record!}; }
async function prediction(authorId:string, options:{status?:'draft'|'published'|'resolved';outcome?:'right'|'wrong'|'void';side?:'yes'|'no';probability?:string;marketPrice?:string|null;resolution?:'yes'|'no';cost?:string;payout?:string}={}) {
  const id=randomUUID(), symbol=`GEMI-FIXTURE-${id}`;
  const [market]=await db.insert(markets).values({instrumentSymbol:symbol,eventTicker:symbol,contractTicker:'UP',title:'Records fixture',tracked:true,
    status:options.outcome==='void'?'invalid':options.status==='resolved'?'settled':'active',resolutionSide:options.resolution??'yes'}).returning();
  await db.insert(theses).values({id,onchainId:hashContent(id),authorId,marketId:market!.id,headline:'Records fixture forecast',body:'Fixture only',side:options.side??'yes',probabilityYes:options.probability??'0.5',
    marketYesPriceAtPublish:options.marketPrice===undefined?'0.6':options.marketPrice,status:options.status??'resolved',outcome:options.outcome??'right',publishedAt:new Date(now)});
  if(options.cost) await db.insert(trades).values({authorId,thesisId:id,marketId:market!.id,side:options.side??'yes',quantity:'10',price:'0.5',costUsd:options.cost,payoutUsd:options.payout??'10',
    status:'settled',isAuthorPosition:true,mode:'paper',idempotencyKey:randomUUID()});
  return {id,market:market!};
}
describe('resolved public records',()=>{
  it('scores hand-computed YES and NO forecasts, excludes void/open/private, and compares identical subsets',async()=>{
    const a=await author();
    await prediction(a.record.id,{probability:'0.5',cost:'5',payout:'10'});
    await prediction(a.record.id,{probability:'0.2',resolution:'no',side:'no',cost:'5',payout:'10',marketPrice:'0.4'});
    await prediction(a.record.id,{probability:'0.7',marketPrice:null});
    await prediction(a.record.id,{outcome:'void',cost:'5',payout:'5'});
    await prediction(a.record.id,{status:'published'}); await prediction(a.record.id,{status:'draft'});
    const [r]=await authorRecords(db,[a.record.id]);
    expect(r).toMatchObject({published:5,resolved:3,right:3,voided:1,marketScored:2,profitUsd:'10.0000'});
    expect(Number(r!.brier)).toBeCloseTo((0.25+0.04+0.09)/3);expect(Number(r!.comparableBrier)).toBeCloseTo(0.145);expect(Number(r!.marketBrier)).toBeCloseTo(0.16);
    const profile=await authorProfile(db,a.record.id);expect(profile?.feed.theses).toHaveLength(5);
  });
  it('never multiplies accuracy or author profit by copier positions or tip rows',async()=>{
    const a=await author(),copier=await createGuest(db,'Private copier');const p=await prediction(a.record.id,{cost:'5',payout:'10'});
    await db.insert(trades).values({userId:copier.id,thesisId:p.id,marketId:p.market.id,side:'yes',quantity:'100',price:'0.5',costUsd:'50',payoutUsd:'100',status:'settled',mode:'paper',isAuthorPosition:false,idempotencyKey:randomUUID()});
    await db.insert(tips).values({thesisId:p.id,userId:copier.id,amountUsdc:'0.1',status:'paid'});
    const [r]=await authorRecords(db,[a.record.id]);expect(r).toMatchObject({resolved:1,profitUsd:'5.0000'});expect(Number(r!.brier)).toBe(0.25);
  });
  it('excludes verification authors and unscored authors from rankings, and hides private-only profiles',async()=>{
    const a=await author(); await prediction(a.record.id);await db.update(authors).set({isTest:true}).where(eq(authors.id,a.record.id));
    const privateAuthor=await author();await prediction(privateAuthor.record.id,{status:'draft'});
    const openAuthor=await author();await prediction(openAuthor.record.id,{status:'published'});
    const board=await leaderboard(db);expect(board.byAccuracy.some(r=>[a.record.id,openAuthor.record.id].includes(r.id))).toBe(false);
    expect(await authorProfile(db,privateAuthor.record.id)).toBeNull();expect(await authorProfile(db,'invalid')).toBeNull();
    expect((await authorProfile(db,a.record.id))?.record.isTest).toBe(true);
  });
  it('groups the complete paid pool before limiting activity, and exposes no private tipper identities',async()=>{
    const a=await author(),copier=await createGuest(db,'Activity copier'),p=await prediction(a.record.id);const hash=`0x${'ab'.repeat(32)}`;
    await db.insert(tips).values(Array.from({length:25},()=>({thesisId:p.id,userId:copier.id,amountUsdc:'0.1',status:'paid' as const,settleTx:hash,settledAt:new Date(midnight)})));
    const result=await escrowActivity(db), item=result.items.find(i=>i.thesisId===p.id&&i.tx===hash);
    expect(item?.amountUsdc).toBe('2.500000');expect(JSON.stringify(result)).not.toContain(copier.id);
  });
});
describe('private account and limits',()=>{
  it('applies reductions immediately and raises only at the next UTC day',async()=>{
    const a=await author();await changeLimits(db,a.user.id,{maxPerTradeUsd:'2',dailyCapUsd:'5'},now);
    expect(await getAccount(db,a.user.id,now)).toMatchObject({maxPerTradeUsd:'2.0000',dailyCapUsd:'5.0000',pendingLimits:null});
    await changeLimits(db,a.user.id,{maxPerTradeUsd:'4',dailyCapUsd:'3'},now);
    const before=await getAccount(db,a.user.id,midnight-1);expect(before).toMatchObject({maxPerTradeUsd:'2.0000',dailyCapUsd:'3.0000',pendingLimits:{maxPerTradeUsd:'4.0000',effectiveAt:new Date(midnight).toISOString()}});
    expect(await getAccount(db,a.user.id,midnight)).toMatchObject({maxPerTradeUsd:'4.0000',dailyCapUsd:'3.0000',pendingLimits:null});
    const [user]=await db.select().from(users).where(eq(users.id,a.user.id));expect(effectiveLimits(user!,midnight).maxPerTradeUsd).toBe('4.0000');
  });
  it('cancels pending increases and promotes due limits before a later change',async()=>{
    const a=await author();await changeLimits(db,a.user.id,{maxPerTradeUsd:'1',dailyCapUsd:'2'},now);
    await changeLimits(db,a.user.id,{maxPerTradeUsd:'5',dailyCapUsd:'10'},now);
    await changeLimits(db,a.user.id,{maxPerTradeUsd:'1',dailyCapUsd:'2'},now);
    expect((await getAccount(db,a.user.id,midnight)).maxPerTradeUsd).toBe('1.0000');
    await changeLimits(db,a.user.id,{maxPerTradeUsd:'5',dailyCapUsd:'10'},now);
    await changeLimits(db,a.user.id,{maxPerTradeUsd:'3',dailyCapUsd:'8'},midnight);
    expect(await getAccount(db,a.user.id,midnight)).toMatchObject({maxPerTradeUsd:'3.0000',dailyCapUsd:'8.0000',pendingLimits:null});
  });
  it('rejects invalid ceilings, extra fields and unknown owners',async()=>{
    for(const input of [{maxPerTradeUsd:'0',dailyCapUsd:'25'},{maxPerTradeUsd:'11',dailyCapUsd:'25'},{maxPerTradeUsd:'10',dailyCapUsd:'26'},{maxPerTradeUsd:'1.001',dailyCapUsd:'5'},{maxPerTradeUsd:'1',dailyCapUsd:'5',userId:randomUUID()}])expect(LimitsInput.safeParse(input).success).toBe(false);
    await expect(changeLimits(db,randomUUID(),{maxPerTradeUsd:'1',dailyCapUsd:'2'},now)).rejects.toThrow('session_required');
  });
  it('returns only the current account history and counts UTC spending including settled positions',async()=>{
    const a=await author(),other=await author(),p=await prediction(a.record.id,{status:'draft'});
    await db.insert(trades).values({userId:a.user.id,marketId:p.market.id,thesisId:p.id,side:'yes',quantity:'2',price:'0.5',costUsd:'1',payoutUsd:'2',status:'settled',mode:'paper',isAuthorPosition:false,idempotencyKey:randomUUID(),createdAt:new Date(now)});
    expect(await getAccount(db,a.user.id,now)).toMatchObject({spentTodayUsd:'1.0000',remainingTodayUsd:'24.0000',positions:[{costUsd:'1.0000'}],theses:[{status:'draft'}]});
    expect(await getAccount(db,other.user.id,now)).toMatchObject({spentTodayUsd:'0.0000',positions:[],theses:[]});
    expect((await getAccount(db,a.user.id,midnight)).spentTodayUsd).toBe('0.0000');
  });
});
