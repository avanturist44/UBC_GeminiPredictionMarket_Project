# Thesis Market extension

Read-only cards under matching X posts. This is the design/post-handling follow-up to Ashley's root-level prototype at commit `28bbd5531d9e86230592572cac825b4b9c9fd7ba`. Agent execution remains owned by Nikita.

## Load it

For an explicit **sample-data design preview**, from the repository root:

```powershell
node apps/extension/build.mjs --sample --site-origin=http://127.0.0.1:3100
```

Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select `apps/extension/dist`. Visit X in your own signed-in browser. Matching examples include Bitcoin, `$BTC`, Ethereum, Fed/rate, Powell/cut and 2028/election. Sample cards say **Sample data · No live prices**, and their mock thesis/comparison actions are disabled. They are not live trades or genuine author-performance evidence.

For Nikita's backend, use its actual origins and omit `--sample`:

```powershell
node apps/extension/build.mjs --api-origin=https://YOUR-API-HOST --site-origin=https://YOUR-APP-HOST
```

Reload the unpacked extension and refresh the X tab after building. `dist` is ignored and reproducible. The build generates permissions for only the configured API origin; post access stays limited to X/Twitter. No wallet or trading permission exists. Credentials must never be placed in this folder.

## Backend contract preserved

`GET /api/ext/markets` returns `{ markets: [{symbol,title,keywords}] }`. Keyword groups match locally; complete groups outrank single terms, with first mention breaking ties. The service worker fetches `GET /api/ext/card?symbol=...`, with the existing payload:

```text
{ symbol, title, yesPrice: number|null, mock?: boolean,
  top: { id, side: "YES"|"NO", entryPrice: number|null, headline, excerpt,
         author: { name, kind: "agent"|"human", resolved, correct, brier } } | null,
  summary: { thesisCount, yesCount, noCount, text } | null }
```

Only symbols are sent to the API. Post text stays in the content script. The backend determines which thesis is featured; the client does not invent an author ranking or generate summaries. The current `avi/ubc-hack` web checkout does **not** implement these extension endpoints, so its existing web preview alone cannot supply live extension cards. Nikita must connect the intended backend. API errors never silently substitute sample data.

The primary live link opens `/thesis/<id>?src=ext`; comparison opens `/markets/<symbol>?src=ext#theses-heading`. Both require the app's normal review/confirmation flow. The previous nonexistent summary-page link was replaced with the market's existing thesis section.

## Design and behavior

- Clear market title and YES probability, distinct featured thesis, author record with early-sample context, and expandable AI summary. “Featured” avoids claiming an unproven “most trusted” author.
- Light, black and dim themes, dynamic theme changes, 320px layouts, long-text wrapping, keyboard focus and native summary controls.
- Missing odds display a dash rather than a fabricated 0%. Unknown entry prices are omitted. Counts of YES/NO theses are labeled as counts, separate from market probability.
- Shadow-root styles and `textContent` insertion isolate the card and keep server text inert.
- Concurrent requests respect the five-card budget. Offscreen cards free slots; recycled posts update their market; delayed post text is handled; quote-post text does not impersonate the outer post.
- Closing a market hides it across posts/page reloads for the browser session. Market lists cache for five minutes; card requests cache for 30 seconds and deduplicate in flight. Failed refreshes explicitly label cached cards and odds as saved.

## Verification

```powershell
node node_modules/vitest/vitest.mjs run apps/extension/test/match.test.ts
node scripts/verify-extension.mjs
```

The browser helper requires local `playwright-core` under `.local/browser-tools/node_modules` and its installed Chromium under `.local/browser-cache`. It starts its own fixture API on port 18173, loads the **actual unpacked MV3 extension** into a fresh headless Chromium profile, and tests authored post fixtures on an intercepted X-origin test route. Follow [Playwright's extension setup](https://playwright.dev/docs/chrome-extensions) for headless persistent-context support. It never signs in, posts, trades or accesses your existing browser profile.

The helper deliberately builds against its local fixture server. After running it, rebuild with `--sample` or your intended backend before loading `dist` manually.

See [the design handoff](../../docs/extension-design-and-post-testing.md) for screenshots, results, live-site limits and teammate integration notes.
