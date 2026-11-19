/** Local-only headless acceptance. Creates one explicitly labeled automated guest and blocked submission. */
import { chromium } from '../.local/browser-tools/node_modules/playwright-core/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin = process.env.AGENT_UI_BASE_URL ?? 'http://127.0.0.1:3100';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const output = new URL('../.local/phase3-ui/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const errors = [], results = [];
page.on('pageerror', error => errors.push(error.message));
async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); throw error; }
}
async function fits() { assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow'); }
let first, blockedId;
try {
  await check('AI feed shows real recorded theses with honest audit labels', async () => {
    const response = await context.request.get(`${origin}/api/feed?kind=agent`);
    assert.equal(response.status(), 200);
    const feed = await response.json(); first = feed.theses[0];
    assert(first && first.position && first.audit);
    assert(!JSON.stringify(feed).includes('circleWalletId'));
  });
  for (const width of [1440, 390, 320]) {
    for (const path of ['/', '/humans', '/write', `/thesis/${first.id}`]) {
      await check(`${path.startsWith('/thesis/') ? 'Thesis detail' : path} fits ${width}px`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${origin}${path}`);
        await page.getByRole('heading', { level: 1 }).waitFor();
        if (path === '/') await page.locator('article').first().waitFor();
        if (path === '/write') await page.locator('select[name="symbol"] option').nth(1).waitFor({ state: 'attached' });
        await page.evaluate(() => document.fonts.ready);
        await fits();
        const label = path === '/' ? 'feed' : path === '/write' ? 'editor' : path === '/humans' ? 'humans' : 'detail';
        await page.screenshot({ path: new URL(`${label}-${width}.png`, output).pathname.replace(/^\/([A-Z]:)/i, '$1'), fullPage: path.startsWith('/thesis/') });
      });
    }
  }
  await check('Agent filter shows the empty News view and restores BTC theses', async () => {
    await page.goto(`${origin}/`);
    await page.getByRole('button', { name: 'News', exact: true }).click();
    await page.getByText('No published theses in this view yet.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'BTC', exact: true }).click();
    await page.locator('article').first().waitFor();
  });
  await check('Editor creates a signed guest session and blocks inside knowledge privately', async () => {
    await page.goto(`${origin}/write`);
    const markets = await (await context.request.get(`${origin}/api/markets`)).json();
    const market = markets.markets.find(m => m.marketState === 'open' && Date.parse(m.expiryAt) - Date.now() > 180_000);
    assert(market, 'A live tracked market is needed for the editor acceptance check.');
    await page.getByLabel('Display name', { exact: true }).fill('Automated UI verification');
    await page.getByLabel('Market', { exact: true }).selectOption(market.symbol);
    await page.getByLabel('Headline', { exact: true }).fill('Automated check: inside information is blocked');
    await page.getByLabel('Your reasoning', { exact: true }).fill('This is an automated blocking check. My friend at the company gave me inside information about the outcome.');
    await page.getByLabel('What does your source support?', { exact: true }).fill('Automated preflight test only');
    await page.getByLabel('Public source URL', { exact: true }).fill('https://www.gemini.com/predictions');
    const submitted = page.waitForRequest(r => r.url() === `${origin}/api/theses` && r.method() === 'POST');
    await page.getByRole('button', { name: 'Audit & place paper trade', exact: true }).click();
    const body = (await submitted).postDataJSON();
    blockedId = body.idempotencyKey;
    await page.waitForURL(`${origin}/thesis/${blockedId}`);
    await page.getByText('This thesis was blocked and is private. No trade was placed.', { exact: true }).waitFor();
    await fits();
    await page.screenshot({ path: new URL('blocked-320.png', output).pathname.replace(/^\/([A-Z]:)/i, '$1'), fullPage: true });
    const me = await (await context.request.get(`${origin}/api/me`)).json();
    assert.equal(me.paperBalanceUsd, '1000.0000');
    const cookies = await context.cookies();
    assert(cookies.some(cookie => cookie.name === 'thesis_session' && cookie.httpOnly && cookie.sameSite === 'Lax'));
    const replay = await context.request.post(`${origin}/api/theses`, { headers: { origin }, data: body });
    assert.equal(replay.status(), 202); assert.equal((await replay.json()).id, blockedId);
  });
  await check('Blocked thesis is excluded from public detail and human feed', async () => {
    const anonymous = await browser.newContext();
    try {
      assert.equal((await anonymous.request.get(`${origin}/api/theses/${blockedId}`)).status(), 404);
      const feed = await (await anonymous.request.get(`${origin}/api/feed?kind=human`)).json();
      assert(!feed.theses.some(thesis => thesis.id === blockedId));
    } finally { await anonymous.close(); }
  });
  await check('Write routes reject cross-origin requests and oversized bodies', async () => {
    assert.equal((await context.request.post(`${origin}/api/session`, { headers: { origin: 'https://attacker.example' }, data: { displayName: 'Cross-site' } })).status(), 403);
    assert.equal((await context.request.post(`${origin}/api/session`, { headers: { origin }, data: { displayName: 'x'.repeat(17_000) } })).status(), 413);
  });
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(error.message); process.exitCode = 1;
  await page.screenshot({ path: new URL('failure.png', output).pathname.replace(/^\/([A-Z]:)/i, '$1'), fullPage: true });
} finally {
  const report = { checkedAt: new Date().toISOString(), results, errors, blockedThesisId: blockedId };
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await browser.close();
}
