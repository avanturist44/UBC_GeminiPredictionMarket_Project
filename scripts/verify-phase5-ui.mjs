/** Headless local-only Phase 5 acceptance. Creates one unfunded guest, never trades or sends USDC. */
import { chromium } from '../.local/browser-tools/node_modules/playwright-core/index.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin='http://127.0.0.1:3100', output=new URL('../.local/phase5-ui/',import.meta.url);
const privateState=JSON.parse(await readFile(new URL('../.local/phase4-live.json',import.meta.url),'utf8'));
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext(), page=await context.newPage();page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const results=[];
const shot=async name=>page.screenshot({path:new URL(name,output).pathname.replace(/^\/([A-Z]:)/i,'$1')});
async function noOverflow() {assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal page overflow');}
try {
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:900});
    await page.goto(`${origin}/leaderboard`);await page.getByRole('button',{name:'By simulated profit',exact:true}).click();
    await page.getByRole('button',{name:'By Brier score',exact:true}).click();
    await page.locator('main ol li, main p.rounded-xl').first().waitFor();await noOverflow();await shot(`records-${width}.png`);
    await page.goto(`${origin}/how-it-works`);await page.getByRole('heading',{name:'Who controls the funds and the result'}).waitFor();await noOverflow();await shot(`explanation-${width}.png`);
    results.push(`public pages fit ${width}px`);
  }
  const board=await (await context.request.get(`${origin}/api/leaderboard`)).json();
  await page.goto(`${origin}/markets/${encodeURIComponent(privateState.attempts.at(-1).symbol)}`);
  await page.getByRole('heading',{name:'Where forecasts differ',exact:true}).waitFor();
  await page.getByText('Humans (0)',{exact:true}).waitFor();
  await page.getByText(/Integration verification test\./).first().waitFor();
  await noOverflow();await shot('disagreement-320.png');results.push('mobile disagreement displays honest group counts and verification labels');
  assert(board.byAccuracy.every(row=>!row.isTest));
  if(board.byAccuracy.length) {
    await page.goto(`${origin}/authors/${board.byAccuracy[0].id}`);await page.getByRole('heading',{name:'Published theses',exact:true}).waitFor();await noOverflow();await shot('author-320.png');
  }
  await page.goto(`${origin}/me`);await page.getByLabel('Display name',{exact:true}).fill('Phase 5 interface verification');
  await page.getByRole('button',{name:'Start guest session',exact:true}).click();
  await page.getByRole('heading',{name:'Your paper limits',exact:true}).waitFor();
  await page.getByLabel('Maximum per trade ($)',{exact:true}).fill('2');await page.getByLabel('Daily cap ($)',{exact:true}).fill('5');
  await page.getByRole('button',{name:'Save paper limits',exact:true}).click();
  await page.getByText('Active: $2.0000 per trade · $5.0000 per UTC day.',{exact:true}).waitFor();
  let account=await(await context.request.get(`${origin}/api/me`)).json();assert.equal(account.maxPerTradeUsd,'2.0000');assert.equal(account.dailyCapUsd,'5.0000');
  await page.getByLabel('Maximum per trade ($)',{exact:true}).fill('4');await page.getByLabel('Daily cap ($)',{exact:true}).fill('8');
  await page.getByRole('button',{name:'Save paper limits',exact:true}).click();await page.getByText(/^Scheduled for /).waitFor();
  account=await(await context.request.get(`${origin}/api/me`)).json();assert.equal(account.maxPerTradeUsd,'2.0000');assert.equal(account.pendingLimits.maxPerTradeUsd,'4.0000');
  await noOverflow();await shot('limits-320.png');results.push('real guest: lower caps immediate, raises scheduled');
  await page.getByLabel('Maximum per trade ($)',{exact:true}).fill('2');await page.getByLabel('Daily cap ($)',{exact:true}).fill('5');
  await page.getByRole('button',{name:'Save paper limits',exact:true}).click();
  await page.getByText(/^Scheduled for /).waitFor({state:'detached'});
  const crossOrigin=await context.request.patch(`${origin}/api/me/limits`,{headers:{origin:'https://example.com'},data:{maxPerTradeUsd:'1',dailyCapUsd:'1'}});assert.equal(crossOrigin.status(),403);
  results.push('cross-origin limit mutation rejected');
  const owner=await browser.newContext();await owner.addCookies([{name:'thesis_session',value:privateState.copier.cookie.slice('thesis_session='.length),url:origin,httpOnly:true,sameSite:'Lax'}]);
  const ownerPage=await owner.newPage();await ownerPage.setViewportSize({width:390,height:900});
  await ownerPage.goto(`${origin}/me`);await ownerPage.getByRole('heading',{name:'Test-USDC tips',exact:true}).waitFor();
  await ownerPage.getByRole('link',{name:'Payout or refund ↗',exact:true}).first().waitFor();
  const ownerAccount=await(await owner.request.get(`${origin}/api/me`)).json();assert(ownerAccount.tips.some(t=>t.status==='refunded'));
  assert(!account.tips.length);results.push('owner sees real settled copy/refund; another guest sees no private history');
  await ownerPage.screenshot({path:new URL('account-390.png',output).pathname.replace(/^\/([A-Z]:)/i,'$1')});
  await owner.close();
  const anonymous=await browser.newContext();const unauthorized=await anonymous.request.patch(`${origin}/api/me/limits`,{headers:{origin},data:{maxPerTradeUsd:'1',dailyCapUsd:'1'}});assert.equal(unauthorized.status(),401);await anonymous.close();
  await page.goto(`${origin}/leaderboard`);await page.locator('main ol li').first().waitFor();
  await page.route('**/api/leaderboard',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Verification: records temporarily unavailable.'})}));
  await page.getByRole('alert').filter({hasText:'Verification: records temporarily unavailable.'}).waitFor({timeout:15000});
  assert(await page.locator('main ol li').count());await page.unroute('**/api/leaderboard');await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Verification: records temporarily unavailable.'}).waitFor({state:'detached'});results.push('ranking read failure retains records and retry recovers');
  await page.getByText(/Arc testnet activity/).click();await page.getByRole('link',{name:'Transaction ↗',exact:true}).first().waitFor();results.push('activity uses confirmed explorer receipt links');
  assert.deepEqual(errors,[]);
  await writeFile(new URL('report.json',output),JSON.stringify({checkedAt:new Date().toISOString(),passed:true,checks:results,browserErrors:errors},null,2));
  console.log(JSON.stringify({passed:true,checks:results,browserErrors:errors}));
}catch(error){console.error(error.message);await shot('failure.png');process.exitCode=1;}
finally{await browser.close();}
