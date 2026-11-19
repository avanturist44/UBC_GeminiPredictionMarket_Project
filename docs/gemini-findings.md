# Phase 0 findings: Gemini, Arc and SDK checks

Every item the build plan marks **Verify**, checked against the live services on November 17, 2026 (UTC).
Re-run the checks with `pnpm verify:gemini`; `--write` refreshes the results table below.

## Decisions

- **`TRADING_MODE=paper`** for agents and users. Fills are simulated at Gemini's live production prices. The sandbox lists the same events with the same symbols, strikes and resolutions, but its prices come from bots and do not track production, so a thesis argued from real prices cannot be traded there honestly. The sandbox stays as the place to demonstrate the real order call: a signed order placed there through the SDK filled on November 17 (see the `order` row below).
- **For `outcome: "no"`, an order's `price` is the NO price.** A sandbox buy of 1 NO contract at the quoted NO ask of 0.97 (YES bid 0.03) filled at 0.97. The adapter sends the NO price as quoted and does not convert.
- **Market data comes from production**, with no key: REST at `https://api.gemini.com`, WebSocket at `wss://ws.gemini.com`.
- **Fetch tracked events one at a time**, not the event list. The unfiltered list is over 25 MB per page because sports events embed their sibling events. Recurring tickers are computable from the clock, so the recorder asks for each tracked event by ticker (about 3 KB each).
- **Tracked markets** are a default of 12 contracts in `packages/core/src/tracked.ts`. The team still owns this choice.

## What changes in the build plan

| Plan says | Live API shows | Effect |
| --- | --- | --- |
| Events have `contractOrderbooks`; contracts have `priceHistory` | Neither field appears in the list or the single-event response | Charts start when recording started (no backfill). The paper adapter must take ask size from the WebSocket `bookTicker` (`A`) or `depth5`, not REST |
| `strike` is a value | `strike` is an object: `{ type, value, availableAt }`. For 15-minute contracts `type` is `reference` and `value` is absent until the window opens | Read `strike.value`. The momentum agent can only price a contract after `availableAt`, which is 15 minutes before expiry, so its "3 to 12 minutes remain" rule fits |
| `marketState` is `open` or `closed` | A third value, `post_only`, appears on approved events | Treat anything other than `open` as not tradable |
| Prices object has `buy`, `sell`, `bestBid`, `bestAsk`, `lastTradePrice` | Any of them can be missing when a side of the book is empty. Books on 15-minute contracts are often one-sided | Every price is nullable in the schema and the database |
| The single-event response has `resolutionSide: null` until resolved | The field is absent until the contract resolves | Treat missing and null the same |
| Not mentioned | Settled contracts carry `settlementValue`, the index value at expiry | A resolved thesis can show "settled at 64,482.43 against a strike of 64,388.56" |
| Index price stream is `{agency}:{index}@indexPrice` | Confirmed. Messages are `{ e: "thirdPartyPrice", s: "btcusd", p: "64637.08…" }`, about one a second | The momentum agent can use it as planned |
| `status=active` lists everything active | The list reports `total: 1000` and stops there; Politics, Economics, Tech and Business events are missing from it | Always pass `category`, or fetch by ticker |
| Sandbox WebSocket is one of two hosts | `wss://ws.sandbox.gemini.com` works; `wss://api.sandbox.gemini.com` does not connect | Use the first |
| Arc RPC is one of two hosts | Both answer with chain ID 5042002, and USDC at `0x3600…0000` reports 6 decimals | Use `https://rpc.testnet.arc.io` |
| Gemini SDK package name unconfirmed | `@gemini-markets/sdk@0.1.1` exists. Server entry: `@gemini-markets/sdk/server`, `createClient({ env: "sandbox", auth: new HmacAuth(...) })`, `gemini.predictions.placeOrder(...)`. It needs Node 22.4 or newer, and `createClient` throws unless the `ws` package is installed. The API key must be account-level (it starts with `account-`): a master key fails with `MissingAccounts`, because the prediction market calls have no account parameter. The key is created with "Uses a time based nonce", so pass `nonceMode: 'time-based'` to `HmacAuth` | Use it for signed calls, with `ws` as a dependency, an account-level key and the time-based nonce |
| Circle SDK method names unconfirmed | `@circle-fin/developer-controlled-wallets@10.8.1` has `createWalletSet`, `createWallets`, `createContractExecutionTransaction`, `getTransaction`, and the blockchain identifier `ARC-TESTNET` | Use as planned |

Quote convention, relevant to item 4: `bestBid` equals `sell.yes`, `bestAsk` equals `buy.yes`, `buy.no` equals `1 - bestBid`, and `sell.no` equals `1 - bestAsk`. Gemini quotes NO at its own price.

## Public WebSocket, checked for Phase 1

Checked against `wss://ws.gemini.com` on November 18, 2026, before the stream client was written. The worker's stream client (`apps/worker/src/stream.ts`) depends on each row.

| Question | What the live socket does |
| --- | --- |
| What is a `bookTicker` message? | `{ u, E, s, b, B, a, A, c?, C? }`. `s` is the symbol in lower case, `b`/`a` are the best bid and ask, `B`/`A` their sizes, and an empty string means that side of the book is empty. `E` is in nanoseconds. `c` is the last trade price: it equalled REST `lastTradePrice` on both contracts compared (0.83 and 0.04), and is absent on a contract that has not traded. The SDK types list `c` and `C` as optional strings without naming them |
| What comes back from `SUBSCRIBE`? | `{ "id": "1", "status": 200 }`, and the current book for each stream at once, before any change |
| Is there an `UNSUBSCRIBE`? | Yes: `{ id, method: "UNSUBSCRIBE", params }` returns status 200 and the messages stop. It also returns 200 for a stream that was never subscribed. `LIST_SUBSCRIPTIONS` returns the current streams. The SDK uses both |
| What if one stream name in a request is wrong? | The whole request is refused: `{ id, status: 400, error: { code: -1013, msg: "Invalid stream name: …" } }`, and none of its streams are subscribed. The client retries each stream alone |
| Is an expired contract's stream still valid? | Yes. It sends one message with an empty book and the last trade |
| Can a web page connect to it? | Yes. It accepted connections with an `Origin` of `http://localhost:3000`, of the deployed site and of `www.gemini.com` alike, and Gemini's own site connects to the same host from the browser. A page cannot send ping frames, so the page's heartbeat is a `LIST_SUBSCRIPTIONS` request |
| Does the server answer a ping frame? | Yes, with a pong at once. The client pings every 15 seconds and reconnects after 45 seconds of silence |

Gemini's site: `https://www.gemini.com/predictions/{eventTicker}` is the event's page (checked with `RECESSION26` and `BRENT2611182200`; an unknown ticker gets the generic page). For each contract the site shows "Yes" as `prices.buy.yes` (the YES ask) and "No" as `prices.buy.no` (one minus the YES bid). The Markets tab shows the same two figures, so they can be compared directly.

## Results of the last run

<!-- verify:start -->
Last run: 2026-11-17T23:31:49.951Z by `pnpm verify:gemini`.

| # | Question | Answer | Detail |
| --- | --- | --- | --- |
| 1 | Does the sandbox list prediction market events, and can orders be placed there? | **partly** | Listing: yes, 88 active events (Crypto, Commodities). Order placement is not checked without a sandbox API key: run with --order. |
| 2 | Do sandbox symbols and resolutions match production? | **yes** | BTC15M2611172345: symbol and strike match (strike 64931.38). ETH15M2611172345: symbol and strike match (strike 1822.05). ETH15M2611172330: production resolved no, sandbox no. SOL15M2611172330: production resolved no, sandbox no. XRP15M2611172330: production resolved no, sandbox no. BTC15M2611172330: production resolved no, sandbox no. Prices differ: sandbox books are made by bots. |
| 3 | Do the OAuth authorize and token paths work on exchange.sandbox.gemini.com? | **partly** | GET /auth returned 303 to /signin. POST /auth/token returned 401 {"error":"invalid_client","error_description":"invalid client id format"}. Both paths exist and behave like production. The full flow needs a registered sandbox app. |
| 4 | For outcome "no", is price the price of NO? | **partly** | Quotes: 319 of 319 two-sided contracts have buy.no = 1 - bestBid and sell.no = 1 - bestAsk (for example GEMI-BTC05M2611172335-UP: bid 0.4, ask 0.5, buy.no 0.6, sell.no 0.5). So Gemini quotes NO at its own price. Whether an order's `price` follows the same convention needs one sandbox order: run with --order. Until then the adapter should convert explicitly. |
| 5 | What are the fees on prediction market orders? | **needs a person** | Not in the public API. The SDK exposes maker-rebate endpoints, so a maker fee exists. Ask Gemini at office hours or read the fill from --order. Paper mode models zero fees and says so. |
| 6 | Is priceHistory filled for short contracts, and at what interval? | **no** | priceHistory present in the BTC15M2611172345 response: false; in the active Crypto list: false. contractOrderbooks present anywhere: false. Charts start when recording started, and ask size for paper fills must come from the WebSocket. |
| 7 | Which assets have 15-minute events right now? | **yes** | 15-minute: BTC, ETH, SOL, XRP. 5-minute: BTC, ETH, SOL, XRP. |
| 8 | Are there non-crypto markets that resolve by 2026-11-20T08:00:00.000Z? | **yes** | Commodities: 6 of 18 (for example BRENT2611182200, COPPER2611182200, NGAS2611182200). Weather: 98 of 98 (for example WXHIGH-ABQ-2611180459, WXHIGH-ANC-2611180459, WXHIGH-ATL-2611180459). Sports was not scanned (its list is over 15 MB) but has many daily events. |
| 9 | Which sandbox WebSocket host is correct? | **yes** | wss://ws.gemini.com: connected, subscribe acknowledged, 6 messages. wss://ws.sandbox.gemini.com: connected, subscribe acknowledged, 6 messages. wss://api.sandbox.gemini.com: failed (connection failed). Use wss://ws.sandbox.gemini.com. |
| ws | What do the public bookTicker and index price streams send? | **yes** | Subscribed on wss://ws.gemini.com to GEMI-BTC15M2611172345-UP@bookTicker and lukka:LS-LRRR-XBTUSD@indexPrice. bookTicker: {"u":1764531769060255,"E":1794958351904397497,"s":"gemi-btc15m2611172345-up","b":"0.3700","B":"3.00","a":"0.4000","A":"5.00"}. Index price: {"e":"thirdPartyPrice","E":1794958349,"s":"btcusd","I":"LRRR_XBT","p":"64903.909166666665","P":"","x":null,"u":366224}. |
| 10 | Which Arc testnet RPC host answers, and is the USDC address correct? | **yes** | https://rpc.testnet.arc.io: chain ID 5042002, USDC decimals() 6. https://rpc.testnet.arc.network: chain ID 5042002, USDC decimals() 6. USDC at 0x3600000000000000000000000000000000000000. |
| 11 | Does a Circle smart contract account on Arc testnet transact without holding gas? | **needs a person** | Needs a Circle API key and entity secret. The SDK (10.8.1) has createWallets, createContractExecutionTransaction and the blockchain identifier ARC-TESTNET. Check in Phase 4, or ask Circle at office hours. |
| 12 | Do the X selectors still match? | **needs a person** | Needs a signed-in browser: inspect a post for article[data-testid="tweet"] and [data-testid="tweetText"]. |
| sdk | Do the Gemini and Circle SDK packages exist on npm under the documented names? | **yes** | @gemini-markets/sdk@0.1.1, @circle-fin/developer-controlled-wallets@10.8.1. |
| lag | How long after expiry does Gemini set resolutionSide? | **yes** | Last 50 settled events. Short crypto windows (44): min 5.5s, median 5.6s, max 8.2s. All contracts (103): min 5.5s, median 7.9s, max 8.3s. |
| strike | When is the strike of a 15-minute contract available? | **yes** | BTC15M2611172345: value 64931.38 (availableAt 2026-11-17T23:30:00.000Z). BTC15M2611180000: value absent (availableAt 2026-11-17T23:45:00.000Z). The strike appears when the window opens, 15 minutes before expiry. |
| order | Can a prediction market order be placed in the sandbox, and how is a NO order priced? | **yes** | Gemini accepted a sandbox order: buy NO, quantity 1, price 0.97 (the quoted NO ask; YES bid was 0.03) on GEMI-BTC15M2611172345-UP. It filled 1 at 0.97, so for outcome "no" the order price is the NO price. The response has no fee field, so item 5 stays open. Response: {"orderId":"145853902320985497","hashOrderId":"LdpAy6Oa5LA4","clientOrderId":"37f9693e-bf27-4225-822c-9fac7c7a7e41","globalOrderId":"a57fceae8540118ee8648e7fa0a9ca0276ca5afcca8e25557f7e55043f49c662","status":"filled","symbol":"GEMI-BTC15M2611172345-UP","side":"buy","outcome":"no","orderType":"limit","timeInForce":"immediate-or-cancel","quantity":"1","filledQuantity":"1","remainingQuantity":"0","price":"0.97","avgExecutionPrice":"0.97","createdAt":"2026-11-17T23:32:46.214Z","updatedAt":"2026-11-17T23:32:46.214Z"}. |
<!-- verify:end -->

## Arc and Circle, checked for Phase 4

Checked on November 18, 2026, with `pnpm --filter @thesis/worker verify:escrow` against the deployed escrow.

| Question | What happened |
| --- | --- |
| Does a Circle smart contract account on Arc testnet transact without holding gas? (item 11) | Yes. A new account was sent 2 USDC, approved the escrow and tipped 0.25 USDC. Its balance afterwards was exactly 1.75 USDC: no gas was taken from it. Each call completed in about 4 seconds |
| Is USDC the same balance through both interfaces? | Yes. The treasury showed 100 USDC as the native token (18 decimals) and 100 through the ERC-20 at `0x3600…0000` (6 decimals). An ERC-20 transfer to a plain account also gives it gas. The app uses the 6-decimal interface only |
| Which explorer verifies source? | `https://explorer.testnet.arc.io` (Blockscout). `forge verify-contract --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/` verified the contract; `testnet.arcscan.app` rejected the same request |
| How long does the whole tip take for a new user? | About 20 seconds from confirming the copy to the tip showing as escrowed: wallet created, funded, approved, tip sent |

## Still open, and who can close it

| # | Question | What is needed |
| --- | --- | --- |
| 5 | Fees on prediction market orders | Gemini at office hours. The sandbox order response has no fee field, and the SDK's prediction market models name fees only for maker rebates |
| 3 | Full OAuth flow in the sandbox | Register an OAuth app at `https://exchange.sandbox.gemini.com/settings/api`. The authorize and token paths exist |
| 12 | X selectors for the extension | A signed-in browser (Phase 6) |
| — | Does live data with simulated fills satisfy the Gemini bounty? | Ask Gemini on the first day of office hours. This is the main risk of choosing paper mode |

## Tracked markets (default)

Rules live in `packages/core/src/tracked.ts`. Recurring events are found by computing their ticker from the clock; for events with several contracts the recorder picks the contract nearest 50 cents the first time it sees the event and then keeps it, so a chart never switches contract.

| Rule | Event | Contract | Resolves |
| --- | --- | --- | --- |
| `btc-15m`, `eth-15m` | `BTC15M…`, `ETH15M…`, current and next window | `UP` | Every 15 minutes |
| `btc-daily`, `eth-daily` | `BTC…2200`, `ETH…2200` | Nearest 50 cents | Daily at 22:00 UTC |
| `brent-daily`, `gold-daily` | `BRENT…2200`, `XAU…2200` | Nearest 50 cents | Daily at 22:00 UTC |
| `nyc-high-temp` | `WXHIGH-NYC-…0459` | Nearest 50 cents | Daily at 04:59 UTC |
| `recession-2026` | `RECESSION26` | `2026` | February 2027 |
| `crypto-market-structure` | `CRYPTOSTRUCT26` | `2027` | January 2027 |
| `best-ai-2026` | `BESTAI26` | `GEMINI` | January 2027 |

No Politics, Economics, Tech or Business event resolves before Friday. The non-crypto markets that resolve this week are commodities, weather and sports, so the `news` agent's short-dated markets are the daily oil, gold and weather contracts; the three long markets appear as open theses only. SOL and XRP also have 15-minute events if more short markets are wanted.
