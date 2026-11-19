/** Headless live confirmation: one $1 paper copy with a 0.10 test-USDC tip. Records its UUID before reading the response. */
import { chromium } from '../.local/browser-tools/node_modules/playwright-core/index.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin = 'http://127.0.0.1:3100', path = new URL('../.local/phase4-live.json', import.meta.url);
const state = JSON.parse(await readFile(path, 'utf8')), attempt = state.attempts.at(-1);
const output = new URL('../.local/phase4-ui/', import.meta.url); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
await context.addCookies([{ name: 'thesis_session', value: state.copier.cookie.slice('thesis_session='.length), url: origin, httpOnly: true, sameSite: 'Lax' }]);
const page = await context.newPage(); page.setDefaultTimeout(20_000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const saveScreenshot = name => page.screenshot({ path: new URL(name, output).pathname.replace(/^\/([A-Z]:)/i, '$1') });
try {
  const existing = await context.request.get(`${origin}/api/copies/${attempt.copyIds.yes}`);
  if (existing.ok()) { console.log('This verification copy already exists. No second copy was submitted.'); }
  else {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${origin}/thesis/${attempt.thesisIds.yes}`);
    await page.getByRole('button', { name: 'Copy trade', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Copy this trade' });
    await dialog.getByLabel('Paper amount ($)', { exact: true }).fill('1');
    await dialog.getByRole('button', { name: 'Review live quote', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm copy trade', exact: true }).waitFor();
    const checkbox = dialog.getByRole('checkbox'); if (await checkbox.count()) await checkbox.check();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth));
      assert((await dialog.innerText()).includes('Most you can lose:'));
      assert((await dialog.innerText()).includes('simulated'));
      await saveScreenshot(`confirmation-${width}.png`);
    }
    const sent = page.waitForRequest(request => request.url().endsWith(`/api/theses/${attempt.thesisIds.yes}/copy`) && request.method() === 'POST');
    await dialog.getByRole('button', { name: 'Confirm copy trade', exact: true }).click();
    const payload = (await sent).postDataJSON();
    attempt.copyIds.yes = payload.idempotencyKey; attempt.quoteTokens.yes = payload.quoteToken;
    await writeFile(path, JSON.stringify(state));
    await dialog.getByRole('heading', { name: 'Paper trade filled', exact: true }).waitFor();
    await saveScreenshot('filled-320.png');
    await dialog.getByRole('link', { name: 'View escrow deposit ↗', exact: true }).waitFor({ timeout: 90_000 });
    await saveScreenshot('escrowed-320.png');
  }
  assert.deepEqual(errors, []);
  await writeFile(new URL('report.json', output), JSON.stringify({ checkedAt: new Date().toISOString(), passed: true, widths: [1440,390,320], copyId: attempt.copyIds.yes, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, copyId: attempt.copyIds.yes, errors }));
} catch (error) { console.error(error.message); await saveScreenshot('failure.png'); process.exitCode = 1; }
finally { await browser.close(); }
