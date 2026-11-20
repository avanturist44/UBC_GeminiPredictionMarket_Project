// Actual website UI, isolated browser profile. API requests are blocked; no trades or sessions are created.
import {chromium} from '../.local/browser-tools/node_modules/playwright-core/index.mjs';
import {readdir,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const origin=process.env.ASCII_PREVIEW_ORIGIN || 'http://127.0.0.1:3217';
const folder=(await readdir('.local/browser-cache')).find(name=>/^chromium-\d+$/.test(name));
assert(folder,'Install the optional Chromium tooling described in docs/website-ascii/README.md');
const browser=await chromium.launch({headless:true,executablePath:`.local/browser-cache/${folder}/chrome-win64/chrome.exe`});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
// Observe actual glyph positions without changing their rendering or animation timing.
await page.addInitScript(()=>{
  const clear=CanvasRenderingContext2D.prototype.clearRect;
  const text=CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.clearRect=function(...args){
    if(this.canvas.classList.contains('ascii-background'))window.__asciiGlyphs=[];
    return clear.apply(this,args);
  };
  CanvasRenderingContext2D.prototype.fillText=function(...args){
    if(this.canvas.classList.contains('ascii-background')&&args[0].length===1){
      (window.__asciiGlyphs??=[]).push({x:args[1],y:args[2]});
    }
    return text.apply(this,args);
  };
});
await page.route('**/api/**',route=>route.abort());
await mkdir('docs/website-ascii',{recursive:true});
try {
  const response=await page.goto(`${origin}/how-it-works`,{waitUntil:'domcontentloaded',timeout:60000});
  assert.equal(response.status(),200);
  await page.locator('.ascii-background').waitFor();
  await page.waitForFunction(()=>{
    const canvas=document.querySelector('.ascii-background');
    return canvas && canvas.width>=innerWidth && getComputedStyle(canvas).pointerEvents==='none';
  });
  assert.equal(await page.locator('.ascii-background').getAttribute('aria-hidden'),'true');
  const contentSurface=await page.locator('main > div').evaluate(node=>({
    background:getComputedStyle(node).backgroundColor,
    backdrop:getComputedStyle(node).backdropFilter,
  }));
  assert.equal(contentSurface.background,'rgb(15, 15, 16)');
  assert.equal(contentSurface.backdrop,'none');
  assert.equal(await page.locator('.site-shell > aside').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(15, 15, 16)');
  const frame=()=>page.locator('canvas.ascii-background').evaluate(node=>node.toDataURL());
  await page.waitForTimeout(300);
  const first=await frame();await page.waitForTimeout(1200);
  assert((await frame())!==first,'Animation should change frames');
  await page.mouse.move(350,350);await page.waitForTimeout(350);
  assert(await page.evaluate(()=>window.__asciiGlyphs.some(({x,y})=>
    Math.abs(x/12-Math.round(x/12))>.01 || Math.abs(y/18-Math.round(y/18))>.01
  )),'Cursor should displace actual glyphs off the resting grid');
  await page.screenshot({path:'docs/website-ascii/interactive.png'});
  await page.mouse.move(-20,-20);await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(()=>window.__asciiGlyphs.length),0,'Glyphs should settle back after the cursor leaves');
  await page.getByRole('button',{name:'Pause background animation'}).click();
  await page.waitForTimeout(150);
  const still=await frame();await page.waitForTimeout(500);
  await page.mouse.move(350,350);await page.waitForTimeout(200);
  assert((await frame())===still,'Pause should freeze the current field');
  assert.equal(await page.evaluate(()=>localStorage.getItem('thesis-background-paused')),'true');
  await page.getByRole('button',{name:'Resume background animation'}).click();
  await page.waitForTimeout(200);
  await page.screenshot({path:'docs/website-ascii/desktop.png'});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForTimeout(200);
  const reduced=await frame();await page.waitForTimeout(500);
  await page.mouse.move(370,380);await page.waitForTimeout(200);
  assert((await frame())===reduced,'Reduced motion should render a static field');
  assert.equal(await page.locator('.ascii-motion-control').isVisible(),false);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(300);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth));
  assert.equal(await page.locator('canvas.ascii-background').evaluate(node=>node.width),390);
  await page.screenshot({path:'docs/website-ascii/mobile.png'});
  assert.deepEqual(errors,[]);
  const report={passed:true,checks:[
    'Actual Next.js page returns HTTP 200',
    'Page blocks and sidebar are opaque graphite with no backdrop blur',
    'ASCII frames change over time',
    'Cursor repels nearby glyphs; they ease back onto the grid after pointer exit',
    'Pointer movement does not disturb paused or reduced-motion frames',
    'Pause freezes the field and saves the local preference',
    'Reduced motion renders a static field and hides the motion control',
    'Decorative canvas is hidden from assistive technology and ignores pointer input',
    '1440px and 390px layouts, canvas resize and no horizontal overflow',
  ],browserErrors:errors,clientApiRequestsBlocked:true,liveBackendVerified:false};
  await writeFile('docs/website-ascii/report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
