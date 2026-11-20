# Thesis Market for X

A Chrome extension (Manifest V3) that adds a card under X posts that mention a tracked market. The card shows the market's YES price, the most trusted thesis on it, and a short summary of the rest, with links to the site.

## Load it

1. Open `chrome://extensions` and turn on Developer mode.
2. Click "Load unpacked" and choose this folder (`apps/extension`). There is no build step.
3. Open x.com and search for "bitcoin" or "recession".

A card appears only for a market that has at least one published thesis.

## Redesigned feed UI

The default card shows the market question, YES probability, featured thesis headline,
author/position and submitted YES/NO thesis counts. Open **Reasoning & author record**
for the existing excerpt, author history and copy-trade link. Open the thesis-count row
for the summary and distribution. Distribution counts describe submitted theses, not
market odds. All existing live links, APIs and trading flows remain in place.

Default, Dim and Lights out themes are supported, including theme changes on mounted
cards. Narrow cards put the odds below the question to keep titles readable. Styles
stay inside the existing shadow root. Sample data remains disclosed and sample IDs
are deliberately noninteractive; live thesis and market links work normally.

There is still **no extension build step**: load `apps/extension` directly, not an old
`dist` folder from another branch. After any edit, reload the extension and refresh X.

See [design, before/after images, checks and limitations](../../docs/extension-ui/README.md)
for reproducible local verification.

## Point it at another server

`constants.js` sets `API_BASE` and `SITE_BASE`, which default to the production site. For a local server (`pnpm dev:web`), set both to `http://localhost:3000`, which `manifest.json` already allows. Then click reload on the extension's card at `chrome://extensions`. Set `USE_MOCK: true` to use the sample data in `mock.js` with no server at all.

## How it works

- `background.js` is the only part that talks to the API: `GET /api/ext/markets` (cached 5 minutes) and `GET /api/ext/card?symbol=` (cached 30 seconds).
- `content.js` reads posts, matches them in the browser with `match.js`, and mounts `card.js`. Post text never leaves the browser; only a matched market's symbol is sent.
- Keyword groups come from `packages/core/src/tracked.ts`, through `markets.keywords`.
- The API side is `apps/web/lib/ext-view.ts`. It decides the top thesis, the excerpt and the summary.

If cards stop appearing, X has probably changed its markup. Check `SELECTORS` in `constants.js` first.
