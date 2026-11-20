# convíx for X

A Chrome extension (Manifest V3) that adds a card under X posts that mention a tracked market. The card shows the market's YES price, the most trusted thesis on it (its author, side, entry price and headline), and how all theses on the market split between Yes and No, one dot each. The button opens that thesis, where copy trade lives; the dots open the market page.

## Load it

1. Open `chrome://extensions` and turn on Developer mode.
2. Click "Load unpacked" and choose this folder (`apps/extension`). There is no build step.
3. Open x.com and search for "bitcoin" or "recession".

A card appears only for a market that has at least one published thesis.

## Point it at another server

`constants.js` sets `API_BASE` and `SITE_BASE`, which default to the production site, https://getconvix.vercel.app. For a local server (`pnpm dev:web`), set both to `http://localhost:3000`, which `manifest.json` already allows. Then click reload on the extension's card at `chrome://extensions`. Set `USE_MOCK: true` to use the sample data in `mock.js` with no server at all.

## How it works

- `background.js` is the only part that talks to the API: `GET /api/ext/markets` (cached 5 minutes) and `GET /api/ext/card?symbol=` (cached 30 seconds).
- `content.js` reads posts, matches them in the browser with `match.js`, and mounts `card.js`. Post text never leaves the browser; only a matched market's symbol is sent.
- Keyword groups come from `packages/core/src/tracked.ts`, through `markets.keywords`.
- The API side is `apps/web/lib/ext-view.ts`. It decides the top thesis, the excerpt and the summary.
- `fonts/` holds Instrument Serif, the site's serif, for the name and the thesis headline, and the ten digits of Source Serif 4, which stand in for Instrument's digits because its 1 looks like an l. Both are under the Open Font License (the `OFL-*.txt` files). `card.js` registers them from the files' bytes, since X's content-security policy would block a font address.

If cards stop appearing, X has probably changed its markup. Check `SELECTORS` in `constants.js` first.
