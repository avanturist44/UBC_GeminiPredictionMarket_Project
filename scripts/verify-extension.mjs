/** Real unpacked MV3 extension in an isolated, headless Chromium profile. No account, posts or trades are created. */
import {chromium} from '../.local/browser-tools/node_modules/playwright-core/index.mjs';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url),output=new URL('.local/extension-verification/',root);await mkdir(output,{recursive:true});
const sample=runInNewContext((await readFile(new URL('apps/extension/mock.js',root),'utf8'))+';MOCK');
const requests=[];let unavailable=false;
const server=createServer(async(req,res)=>{requests.push({method:req.method,url:req.url});res.setHeader('content-type','application/json');
  if(unavailable){res.writeHead(503);res.end('{}');return;}
  const url=new URL(req.url,'http://localhost');await new Promise(r=>setTimeout(r,80));
  if(url.pathname==='/api/ext/markets')res.end(JSON.stringify({markets:sample.markets}));
  else if(url.pathname==='/api/ext/card')res.end(JSON.stringify(sample.cards[url.searchParams.get('symbol')]??null));else{res.writeHead(404);res.end('{}');}
});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(18173,'127.0.0.1',resolve);});
execFileSync(process.execPath,[fileURLToPath(new URL('apps/extension/build.mjs',root)),'--api-origin=http://127.0.0.1:18173','--site-origin=http://127.0.0.1:3100']);
const cache=new URL('.local/browser-cache/',root),folder=(await readdir(cache)).find(n=>/^chromium-\d+$/.test(n));assert(folder,'Install Playwright Chromium first');
const executablePath=fileURLToPath(new URL(`${folder}/chrome-win64/chrome.exe`,cache));
const path=fileURLToPath(new URL('apps/extension/dist/',root));
const context=await chromium.launchPersistentContext(fileURLToPath(new URL(`profile-${Date.now()}/`,output)),{headless:true,channel:'chromium',executablePath,args:[`--disable-extensions-except=${path}`,`--load-extension=${path}`]});
const checks=[],errors=[],live=[];
context.on('page',p=>p.on('pageerror',error=>errors.push(error.message)));
let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');
const shell=`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:white;color:#0f1419;font:15px/1.5 Arial}body.dark{background:#000;color:#e7e9ea}body.dim{background:#15202b;color:#edf2f6}main{max-width:600px;margin:auto;border:1px solid #8899a633}h1{margin:0;padding:16px;font-size:17px;border-bottom:1px solid #8899a633}.notice{padding:8px 16px;color:#708090;font-size:11px}article{padding:16px;border-bottom:1px solid #8899a633}.author{font-weight:700;margin-bottom:8px}.post-text{white-space:pre-wrap;overflow-wrap:anywhere}.media{height:120px;margin-top:12px;border-radius:12px;background:#8899a622}.controls{display:flex;justify-content:space-between;font-size:12px;color:#708090;margin-top:14px}</style><main><h1>Post context</h1><div class="notice">LOCAL EXTENSION TEST · Authored posts / sample market cards</div><div id="posts"></div></main>`;
await context.route('https://x.com/__tm_test__/**',route=>route.fulfill({status:200,contentType:'text/html',body:shell}));
const page=await context.newPage();page.setDefaultTimeout(15_000);
async function fixture(name,posts,{width=600,theme='light'}={}){
  await page.setViewportSize({width,height:1100});await page.goto(`https://x.com/__tm_test__/${name}`);
  await page.evaluate(({posts,theme})=>{document.body.className=theme==='light'?'':theme;for(const [i,text]of posts.entries()){
    const post=document.createElement('article');post.dataset.testid='tweet';post.id=`post-${i}`;const author=document.createElement('div');author.className='author';author.textContent=`Test author ${i+1} · @fixture${i+1}`;
    const body=document.createElement('div');body.dataset.testid='tweetText';body.className='post-text';body.textContent=text;
    const controls=document.createElement('div');controls.className='controls';controls.textContent='Reply          Repost          Like          Share';post.append(author,body,controls);document.querySelector('#posts').append(post);
  }},{posts,theme});
}
const cards=()=>page.locator('[data-tm-card]');
async function screenshot(name){await page.screenshot({path:fileURLToPath(new URL(name,output))});}
async function overflow(){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert(await cards().evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().right<=innerWidth+1)));}
try{
  await fixture('bitcoin',['Bitcoin is back in the conversation. What public evidence would change your mind?']);await cards().first().waitFor();
  assert.equal(await cards().count(),1);await page.getByText('Across 9 theses',{exact:true}).click();await screenshot('bitcoin-light-desktop.png');checks.push('actual MV3 service worker, content script and shadow-root card loaded');
  assert(await cards().locator('a').filter({hasText:'How it works'}).count());assert(await cards().getByText('Sample data · No live prices',{exact:true}).count());
  for(const [name,post,theme,width]of [
    ['fed-dark','The Fed rate decision is tomorrow. Powell could still cut.','dark',600],
    ['ethereum-dim','ETHEREUM: a long thread on public evidence, uncertainty, and the ETH/BTC ratio.','dim',390],
    ['politics-phone','The 2028 election and presidential nominee race are worth following.','light',320],
    ['long-text','Bitcoin '+('longunbrokenword'.repeat(35))+' 🚀\nA second paragraph about public evidence.','dark',320],
  ]){await fixture(name,[post],{theme,width});await cards().first().waitFor();if(name==='ethereum-dim')assert.equal(await cards().first().getAttribute('data-tm-card'),'ETH-4K-DEC');await overflow();await screenshot(`${name}.png`);}
  checks.push('Bitcoin, Fed, Ethereum and politics posts; long text; light/dark/dim at 600, 390 and 320px');
  await fixture('irrelevant',['My cat is sleeping.','Ethernet weather forecast and FedEx deliveries.']);await page.waitForTimeout(800);assert.equal(await cards().count(),0);checks.push('irrelevant posts and substring false positives produce no card');
  await fixture('quoted',['My cat is sleeping.']);await page.evaluate(()=>{const quote=document.createElement('div');quote.dataset.testid='quoteTweet';const text=document.createElement('div');text.dataset.testid='tweetText';text.textContent='Bitcoin';quote.append(text);document.querySelector('article').append(quote);});await page.waitForTimeout(800);assert.equal(await cards().count(),0);checks.push('quoted-post text does not incorrectly match the outer post');
  await fixture('recycle',['Bitcoin public discussion.']);await cards().first().waitFor();await page.evaluate(()=>document.querySelector('[data-testid="tweetText"]').textContent='Ethereum public discussion.');await page.locator('[data-tm-card="ETH-4K-DEC"]').waitFor();assert.equal(await cards().count(),1);checks.push('recycled post replaces its old market card');
  await fixture('delayed',[]);await page.evaluate(()=>{const p=document.createElement('article');p.dataset.testid='tweet';p.id='delayed';document.querySelector('#posts').append(p);});await page.waitForTimeout(250);await page.evaluate(()=>{const t=document.createElement('div');t.dataset.testid='tweetText';t.textContent='Bitcoin arrives after the article.';document.querySelector('#delayed').append(t);});await cards().first().waitFor();checks.push('late-arriving post text is processed');
  await fixture('limit',Array.from({length:20},(_,i)=>`Bitcoin post ${i}: public evidence.`));await cards().first().waitFor();await page.waitForTimeout(1200);assert((await cards().count())<=5);checks.push('concurrent loads never exceed five mounted cards');
  const host=cards().first();await host.getByRole('button',{name:/Hide /}).click();await page.waitForTimeout(300);assert.equal(await cards().count(),0);
  await fixture('dismissed-reload',['Bitcoin after a page reload.']);await page.waitForTimeout(900);assert.equal(await cards().count(),0);checks.push('close hides the market across posts and page reloads for the browser session');
  assert(requests.every(r=>r.method==='GET'&&(/^\/api\/ext\/markets$/.test(r.url)||/^\/api\/ext\/card\?symbol=[A-Za-z0-9%._-]+$/.test(r.url))));checks.push('API receives only read-only market requests and symbols, never post text');
  // No authenticated browser/profile is used. Live-site attempts are reported separately from fixtures.
  await worker.evaluate(()=>chrome.storage.session.clear());
  await worker.evaluate('globalThis.__testOriginalNow=Date.now;Date.now=()=>globalThis.__testOriginalNow()+31000');
  sample.cards['ETH-4K-DEC'].mock=false;
  await fixture('offline-prime',['Ethereum public evidence.']);await cards().first().waitFor();await page.getByText('Simulated fills · Testnet tips',{exact:true}).waitFor();
  assert.equal(new URL(await cards().locator('a.cta').getAttribute('href')).origin,'http://127.0.0.1:3100');
  unavailable=true;await worker.evaluate('Date.now=()=>globalThis.__testOriginalNow()+62000');
  await fixture('offline',['Ethereum after a connection interruption.']);await page.getByText('Saved data · Refresh unavailable',{exact:true}).waitFor();await screenshot('offline-phone.png');unavailable=false;
  checks.push('API outage labels cached card and odds as saved, with safe website links');
  await worker.evaluate('Date.now=()=>globalThis.__testOriginalNow()+93000');
  const unsafe=sample.cards['PRES2028-DEM'];unsafe.mock=false;unsafe.yesPrice=null;unsafe.top.side='NO';unsafe.top.entryPrice=null;unsafe.top.author.resolved=0;unsafe.top.headline='<img src=x onerror=alert(1)> is untrusted text';
  await fixture('invalid',['2028 election discussion.'],{width:320});await cards().getByText('No resolved forecasts yet',{exact:true}).waitFor();
  assert((await cards().locator('.odds').innerText()).startsWith('—'));assert.equal(await cards().locator('img,script').count(),0);assert(await cards().getByText('NO',{exact:true}).count());await overflow();checks.push('missing odds are not 0%, NO renders correctly, untrusted HTML stays inert');
  await page.evaluate(()=>document.body.className='dark');await cards().locator('.card.dark').waitFor();
  const summary=cards().locator('summary');await summary.focus();await page.keyboard.press('Enter');assert(await cards().locator('details[open]').count());checks.push('theme updates on the existing card and summary is keyboard accessible');
  await worker.evaluate('Date.now=globalThis.__testOriginalNow');
  for(const url of ['https://x.com/BitcoinMagazine/status/1972946715830587827','https://x.com/federalreserve/status/1963255999097127245']){
    const livePage=await context.newPage();try{await livePage.goto(url,{waitUntil:'domcontentloaded',timeout:20_000});await livePage.waitForTimeout(2500);live.push({url,postArticles:await livePage.locator('article[data-testid="tweet"]').count(),postTextNodes:await livePage.locator('[data-testid="tweetText"]').count(),result:await livePage.locator('article[data-testid="tweet"]').count()?'post DOM accessible':'no post DOM available without sign-in'});}catch{live.push({url,result:'live page unavailable in isolated headless browser'});}finally{await livePage.close();}
  }
  assert.deepEqual(errors,[]);const report={checkedAt:new Date().toISOString(),passed:true,checks,liveSiteAttempts:live,browserErrors:errors,fixtureMarketData:true,liveBackendVerified:false};await writeFile(new URL('report.json',output),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){console.error(error.message);await screenshot('failure.png');process.exitCode=1;}
finally{await context.close();await new Promise(resolve=>server.close(resolve));}
