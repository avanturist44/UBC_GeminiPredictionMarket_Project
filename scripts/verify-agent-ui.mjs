/** Headless browser acceptance checks. Setup and outputs: docs/verification-2026-11-18.md. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../.local/browser-tools/node_modules/playwright-core/index.mjs';

const base = new URL(process.env.AGENT_UI_BASE_URL ?? 'http://127.0.0.1:3100');
assert(['localhost', '127.0.0.1'].includes(base.hostname), 'Use a local verification server.');
const output = fileURLToPath(new URL('../.local/agent-ui/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
});
const results = [];
const errors = [];
const context = await browser.newContext();
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(15_000);
async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) {
    results.push({ name, passed: false, error: error.message });
    await page.screenshot({ path: `${output}failure.png`, fullPage: true });
    throw error;
  }
}
async function fits() {
  const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert(geometry.scroll <= geometry.width, `Horizontal overflow: ${JSON.stringify(geometry)}`);
}
const filter = name => page.getByRole('button', { name, exact: true });
let responseMode = 'fixture';
const fixture = () => ({ asOf: new Date().toISOString(), events: [{
  id: 'browser-only-news', agent: 'news', at: new Date(Date.now() - 180_000).toISOString(),
  market: `Long market title ${'M'.repeat(160)}`, stage: 'Researching', mode: 'Log only',
  summary: `Browser-only fixture ${'S'.repeat(180)}`,
  checks: [{ label: 'Estimated YES probability', value: '63.0%' }, { label: 'BTC index', value: '$62,500.25' }],
  sources: [{ url: 'https://example.com/research', claim: `Evidence ${'C'.repeat(180)}` }],
}] });
try {
  await check('Live API and milestone records', async () => {
    const response = await context.request.get(new URL('/api/agents/activity', base).href);
    assert.equal(response.status(), 200);
    const data = await response.json();
    assert(data.events.some(event => event.stage === 'Paper entry'), 'Expected recorded paper entry.');
    assert(data.events.some(event => event.stage === 'Settled'), 'Expected recorded settlement.');
  });
  for (const width of [1440, 768, 390, 320]) {
    await check(`Live layout at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(new URL('/agents', base).href);
      await page.getByRole('heading', { name: 'Watch the decisions unfold.' }).waitFor();
      await page.locator('article').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await fits();
      const nav = page.getByRole('navigation', { name: 'Primary', exact: true }).filter({ visible: true });
      assert.equal(await nav.getByRole('link', { name: 'AI', exact: true }).getAttribute('aria-current'), 'page');
      await page.screenshot({ path: `${output}live-${width}.png`, fullPage: true });
      await page.screenshot({ path: `${output}viewport-${width}.png` });
    });
  }
  await check('Agent filters and expandable inputs', async () => {
    await filter('News').click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'News' && button.getAttribute('aria-pressed') === 'true'));
    assert.equal(await filter('News').getAttribute('aria-pressed'), 'true');
    assert(await page.locator('article').count() > 0);
    assert((await page.locator('article').allTextContents()).every(text => text.includes('News research')));
    await filter('BTC').click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'BTC' && button.getAttribute('aria-pressed') === 'true'));
    assert(await page.locator('article').count() > 0);
    assert((await page.locator('article').allTextContents()).every(text => text.includes('BTC momentum')));
    const summary = page.locator('article summary').first();
    await summary.click();
    await page.locator('article details[open] dd').first().waitFor();
    assert.equal(await summary.locator('..').getAttribute('open'), '');
    assert(await page.locator('article details[open] dd').count() > 0);
    await fits();
    await filter('All').click();
  });
  await check('Automatic live polling', async () => {
    const response = await page.waitForResponse(r => r.url().endsWith('/api/agents/activity') && r.status() === 200, { timeout: 12_000 });
    assert((await response.json()).asOf);
  });
  // Browser response mocks only: fixtures never reach the worker or database.
  await page.route('**/api/agents/activity', route => route.fulfill({
    status: responseMode === 'error' ? 503 : 200, contentType: 'application/json',
    body: JSON.stringify(responseMode === 'error' ? { message: 'Browser-only unavailable response' }
      : responseMode === 'empty' ? { asOf: new Date().toISOString(), events: [] } : fixture()),
  }));
  await check('Narrow layout with long market, summary and citation text', async () => {
    await page.reload();
    await page.getByRole('heading', { name: /Long market title/ }).waitFor();
    await page.locator('article summary').click();
    await page.getByText('Research update overdue', { exact: true }).first().waitFor();
    const source = page.locator('article a');
    assert.equal(await source.getAttribute('target'), '_blank');
    assert.equal(await source.getAttribute('rel'), 'noopener noreferrer');
    await fits();
    await page.screenshot({ path: `${output}long-text-320.png`, fullPage: true });
  });
  await check('Failed refresh retains data; retry recovers to empty state', async () => {
    responseMode = 'error';
    const alert = page.locator('main [role="alert"]');
    await alert.waitFor({ timeout: 12_000 });
    assert((await alert.innerText()).includes('Showing the last successful read.'));
    assert.equal(await page.locator('article').count(), 1);
    await page.screenshot({ path: `${output}error-320.png`, fullPage: true });
    responseMode = 'empty';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByText('No decisions recorded yet for this view.').waitFor();
    await alert.waitFor({ state: 'detached' });
    assert.equal(await page.locator('article').count(), 0);
    await page.screenshot({ path: `${output}empty-320.png` });
  });
  await check('No uncaught browser or hydration errors', async () => assert.deepEqual(errors, []));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  const report = { checkedAt: new Date().toISOString(), results, errors };
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
