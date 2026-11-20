// Real MV3 extension + isolated X-origin fixtures. Never uses an existing browser profile.
import {chromium} from '../.local/browser-tools/node_modules/playwright-core/index.mjs';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url), baseline=process.argv.includes('--baseline');
const output=new URL('docs/extension-ui/',root), work=new URL('.local/extension-ui-verification/',root);
await mkdir(output,{recursive:true});await mkdir(work,{recursive:true});
const extension=new URL(baseline?'before/':'after/',work);await mkdir(extension,{recursive:true});
for(const file of ['manifest.json','constants.js','background.js','mock.js','match.js','card.js','content.js']){
  let text=baseline?execFileSync('git',['show',`963f180:apps/extension/${file}`],{cwd:fileURLToPath(root),encoding:'utf8'}):await readFile(new URL('apps/extension/'+file,root),'utf8');
  if(file==='constants.js')text=text.replace(/API_BASE: "[^"]+"/,'API_BASE: "http://127.0.0.1:18174"');
  if(file==='manifest.json'){const manifest=JSON.parse(text);manifest.host_permissions=['http://127.0.0.1:18174/*'];text=JSON.stringify(manifest);}
  await writeFile(new URL(file,extension),text);
}
const sample=runInNewContext((await readFile(new URL('apps/extension/mock.js',root),'utf8'))+';MOCK');
const requests=[];
const server=createServer((req,res)=>{requests.push({method:req.method,url:req.url});res.setHeader('content-type','application/json');
  const url=new URL(req.url,'http://localhost');
  res.end(JSON.stringify(url.pathname==='/api/ext/markets'?{markets:sample.markets}:sample.cards[url.searchParams.get('symbol')]??null));
});await new Promise(resolve=>server.listen(18174,'127.0.0.1',resolve));
const cache=new URL('.local/browser-cache/',root),folder=(await readdir(cache)).find(n=>/^chromium-\d+$/.test(n));
const path=fileURLToPath(extension);
let context;
const checks=[],errors=[],live=[];
try{
  context=await chromium.launchPersistentContext(fileURLToPath(new URL(`profile-${Date.now()}/`,work)),{
    headless:true,channel:'chromium',executablePath:fileURLToPath(new URL(`${folder}/chrome-win64/chrome.exe`,cache)),
    args:[`--disable-extensions-except=${path}`,`--load-extension=${path}`]});
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');
  worker.on('console',msg=>console.log('worker:',msg.text()));
  await worker.evaluate(()=>chrome.storage.session.clear());
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  const shell=`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#0f1419;font:15px/1.5 Arial}body.dark{background:#000;color:#e7e9ea}body.dim{background:#15202b;color:#f7f9f9}main{max-width:600px;margin:auto;border-inline:1px solid #8899a633}.notice{padding:12px 16px;border-bottom:1px solid #8899a633;font-size:11px;color:#84919c}article{padding:16px;border-bottom:1px solid #8899a633}.post{display:flex;gap:12px}.avatar{width:36px;height:36px;flex-shrink:0;border-radius:50%;background:#536471;display:grid;place-items:center;color:#fff;font-size:12px}.body{min-width:0;flex:1}.author{font-size:14px;margin-bottom:4px}.handle{color:#84919c;font-size:13px}.text{overflow-wrap:anywhere}.media{height:120px;background:#8899a622;margin-top:12px;border:1px solid #8899a633;border-radius:8px}.controls{display:flex;justify-content:space-between;color:#84919c;font-size:12px;margin-top:12px}</style><main><div class="notice">LOCAL UI TEST · Existing sample market data · No live quotes</div><div id="posts"></div></main>`;
  await context.route('https://x.com/__tm_ui__/**',route=>route.fulfill({contentType:'text/html',body:shell}));
  async function fixture(name,{width=600,theme='dark',text='Bitcoin: what evidence would change your position before year end?',media=false,thread=false}={}){
    await page.setViewportSize({width,height:1050});await page.goto('https://x.com/__tm_ui__/'+name);
    await page.evaluate(({theme,text,media,thread})=>{document.body.className=theme;document.querySelector('#posts').innerHTML=`<article data-testid="tweet"><div class="post"><div class="avatar">TM</div><div class="body"><div class="author">Market observer <span class="handle">@observer · 2h</span></div><div class="text" data-testid="tweetText"></div>${media?'<div class="media" aria-label="Post media placeholder"></div>':''}<div class="controls"><span>Reply</span><span>Repost</span><span>Like</span><span>Share</span></div></div></div></article>${thread?'<article>Another post in this thread</article>':''}`;document.querySelector('[data-testid="tweetText"]').textContent=text;},{theme,text,media,thread});
    try { await page.locator('[data-tm-card]').first().waitFor(); }
    catch(error) { console.log(JSON.stringify({requests,errors,state:await page.locator('article').evaluateAll(ns=>ns.map(n=>({state:n.dataset.tmState,text:n.innerText}))),worker:await worker.evaluate(()=>({base:TM.API_BASE,cache:[...cardCache.entries()]}))})); throw error; }
  }
  const card=()=>page.locator('[data-tm-card]').first();
  async function screenshot(name){await page.screenshot({path:fileURLToPath(new URL(name,output)),fullPage:true});}
  async function fits(){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert(await card().evaluate(host=>{const box=host.getBoundingClientRect();return [...host.shadowRoot.querySelectorAll('.card,.market,.title,.head,.sec,.foot')].every(n=>n.getBoundingClientRect().right<=box.right+1&&n.scrollWidth<=n.clientWidth+1);}));}
  await fixture('desktop');await screenshot(baseline?'before-dark.png':'after-dark.png');
  const height=await card().evaluate(n=>n.getBoundingClientRect().height);
  if(baseline){await writeFile(new URL('baseline.json',work),JSON.stringify({height}));console.log(JSON.stringify({baseline:true,height}));}
  else{
    assert.equal(await card().locator('details[open]').count(),0);await fits();
    const before=JSON.parse(await readFile(new URL('baseline.json',work),'utf8'));assert(height<before.height*.8);
    checks.push(`Collapsed card ${Math.round(height)}px vs ${Math.round(before.height)}px before (${Math.round((1-height/before.height)*100)}% shorter), identical fixture`);
    await card().getByText('Reasoning & author record',{exact:true}).click();
    await card().getByText('9 theses',{exact:true}).click();await screenshot('after-expanded.png');await fits();
    assert(await card().getByText('Submitted thesis positions · not market probability',{exact:true}).isVisible());
    assert.equal(await card().locator('a').count(),0);checks.push('Sample cards disclosed; fictitious sample thesis links are noninteractive');
    for(const [name,options]of [['light',{theme:'light',media:true}],['dim-phone',{theme:'dim',width:390,text:'Ethereum and the ETH/BTC ratio.'}],['narrow-thread',{width:320,thread:true,text:'The 2028 presidential election: '+ 'Long post text '.repeat(20)}]]){
      await fixture(name,options);await fits();await screenshot(`after-${name}.png`);
    }
    await page.evaluate(()=>document.body.className='light');await card().locator('.card.light').waitFor();
    await page.evaluate(()=>document.body.className='dim');await card().locator('.card.dim').waitFor();checks.push('Light, dark, dim; dynamic theme changes; 320/390/600px; text, media and thread layouts');
    // Use the same renderer directly for exhaustive payload states, independently of worker caches.
    await page.addScriptTag({content:await readFile(new URL('apps/extension/constants.js',root),'utf8')});
    await page.addScriptTag({content:await readFile(new URL('apps/extension/card.js',root),'utf8')});
    async function render(data){await page.evaluate(data=>{document.querySelectorAll('[data-tm-card]').forEach(n=>n.remove());document.querySelector('[data-testid="tweetText"]').after(TMCard.mount(data,{onClose:()=>{window.closedMarket=true;document.querySelector('[data-tm-card]').remove();}}));},data);}
    const base=structuredClone(sample.cards['BTC-100K-DEC']);base.mock=false;
    for(const price of [0,1,null,NaN,-.2,2]){
      const data=structuredClone(base);data.yesPrice=price;data.top.side='NO';data.top.entryPrice=null;data.top.author=null;data.title='Verylongmarketquestion'.repeat(12);data.top.headline='<img src=x onerror=alert(1)> '+ 'Longunbrokenthesistitle'.repeat(30);
      await render(data);await fits();
      assert((await card().locator('.value').innerText()).startsWith(price===0?'0%':price===1?'100%':'—'));
      assert.equal(await card().locator('img,script').count(),0);assert.equal(await card().locator('.bet').innerText(),'NO');
    }
    checks.push('0%/100% and missing/invalid prices; NO position; missing author/entry; long titles; inert server HTML');
    await render({...base,top:null});assert.equal(await card().locator('.thesis-details').count(),0);await fits();
    await render({...base,summary:null});assert.equal(await card().locator('details').count(),1);
    await render({...base,summary:{thesisCount:2,yesCount:0,noCount:0,text:null}});await card().getByText('2 theses',{exact:true}).click();assert.equal(await card().locator('.bar').count(),0);
    await render(base);const trigger=card().locator('summary').first();await trigger.focus();await page.keyboard.press('Enter');assert.equal(await card().locator('details[open]').count(),1);
    assert.match(await card().locator('a.cta').getAttribute('href'),/\/thesis\/t_ai_3\?src=ext$/);
    assert.match(await card().locator('a.market-link').getAttribute('href'),/\/markets\/BTC-100K-DEC\?src=ext$/);
    assert(await card().getByText('Test funds only',{exact:true}).isVisible());
    await card().getByRole('button',{name:'Hide cards for this market'}).click();assert(await page.evaluate(()=>window.closedMarket));
    checks.push('No featured thesis/no summary/zero counts; keyboard disclosure; original deep links and hide callback; test-fund disclosure');
    assert(requests.every(r=>r.method==='GET'&&r.url.startsWith('/api/ext/')));checks.push('Real MV3 worker/content script loaded; fixture API receives GET requests and symbols only');
    for(const url of ['https://x.com/BitcoinMagazine','https://x.com/federalreserve']){
      const p=await context.newPage();try{await p.goto(url,{waitUntil:'domcontentloaded',timeout:15000});await p.waitForTimeout(2000);live.push({url,posts:await p.locator('article[data-testid="tweet"]').count()});}catch(e){live.push({url,result:'Unavailable: '+e.message.split('\n')[0]});}await p.close();
    }
    assert.deepEqual(errors,[]);
    const report={passed:true,checks,browserErrors:errors,liveAttempts:live,fixtureData:true,liveTradingVerified:false};
    await writeFile(new URL('report.json',output),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }
}finally{await context?.close();await new Promise(resolve=>server.close(resolve));}
