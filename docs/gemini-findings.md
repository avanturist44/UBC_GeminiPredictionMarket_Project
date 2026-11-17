# Phase 0 findings: Gemini, Arc and SDK checks

Every item the build plan marks **Verify**, checked against the live services on November 17, 2026 (UTC).
Re-run the checks with `pnpm verify:gemini`; `--write` refreshes the results table below.

## Decisions

- **`TRADING_MODE=paper`** for agents and users. Fills are simulated at Gemini's live production prices. The sandbox lists the same events with the same symbols, strikes and resolutions, but its prices come from bots and do not track production, so a thesis argued from real prices cannot be traded there honestly. The sandbox stays as the place to demonstrate the real order call once an API key exists.
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
| Gemini SDK package name unconfirmed | `@gemini-markets/sdk@0.1.1` exists. Server entry: `@gemini-markets/sdk/server`, `createClient({ env: "sandbox", auth: new HmacAuth(...) })`, `gemini.predictions.placeOrder(...)`. It needs Node 22.4 or newer, and `createClient` throws unless the `ws` package is installed. With a made-up key the sandbox answers HTTP 400, so the signed path reaches Gemini | Use it for signed calls, with `ws` as a dependency |
| Circle SDK method names unconfirmed | `@circle-fin/developer-controlled-wallets@10.8.1` has `createWalletSet`, `createWallets`, `createContractExecutionTransaction`, `getTransaction`, and the blockchain identifier `ARC-TESTNET` | Use as planned |

Quote convention, relevant to item 4: `bestBid` equals `sell.yes`, `bestAsk` equals `buy.yes`, `buy.no` equals `1 - bestBid`, and `sell.no` equals `1 - bestAsk`. Gemini quotes NO at its own price.

WebSocket `bookTicker` message, for Phase 1: `{ u, E, s, b, B, a, A }` where `s` is the symbol in lower case, `b`/`a` are best bid and ask, `B`/`A` their sizes, and an empty string means that side of the book is empty. `E` is in nanoseconds.

## Results of the last run

<!-- verify:start -->
Last run: 2026-11-17T07:59:57.200Z by `pnpm verify:gemini`.

| # | Question | Answer | Detail |
| --- | --- | --- | --- |
| 1 | Does the sandbox list prediction market events, and can orders be placed there? | **partly** | Listing: yes, 96 active events (Crypto, Commodities). Order placement is not checked without a sandbox API key: run with --order. |
| 2 | Do sandbox symbols and resolutions match production? | **yes** | BTC15M2611170815: symbol and strike match (strike pending). ETH15M2611170815: symbol and strike match (strike pending). XRP15M2611170745: production resolved no, sandbox no. ETH15M2611170745: production resolved no, sandbox no. BTC15M2611170745: production resolved no, sandbox no. SOL15M2611170745: production resolved no, sandbox no. Prices differ: sandbox books are made by bots. |
| 3 | Do the OAuth authorize and token paths work on exchange.sandbox.gemini.com? | **partly** | GET /auth returned 303 to /signin. POST /auth/token returned 401 {"error":"invalid_client","error_description":"invalid client id format"}. Both paths exist and behave like production. The full flow needs a registered sandbox app. |
| 4 | For outcome "no", is price the price of NO? | **partly** | Quotes: 295 of 295 two-sided contracts have buy.no = 1 - bestBid and sell.no = 1 - bestAsk (for example GEMI-BTC05M2611170800-UP: bid 0.54, ask 0.99, buy.no 0.46, sell.no 0.01). So Gemini quotes NO at its own price. Whether an order's `price` follows the same convention needs one sandbox order: run with --order. Until then the adapter should convert explicitly. |
| 5 | What are the fees on prediction market orders? | **needs a person** | Not in the public API. The SDK exposes maker-rebate endpoints, so a maker fee exists. Ask Gemini at office hours or read the fill from --order. Paper mode models zero fees and says so. |
| 6 | Is priceHistory filled for short contracts, and at what interval? | **no** | priceHistory present in the BTC15M2611170815 response: false; in the active Crypto list: false. contractOrderbooks present anywhere: false. Charts start when recording started, and ask size for paper fills must come from the WebSocket. |
| 7 | Which assets have 15-minute events right now? | **yes** | 15-minute: BTC, ETH, SOL, XRP. 5-minute: BTC, ETH, SOL, XRP. |
| 8 | Are there non-crypto markets that resolve by 2026-11-20T08:00:00.000Z? | **yes** | Commodities: 6 of 18 (for example BRENT2611172200, COPPER2611172200, NGAS2611172200). Weather: 49 of 49 (for example WXHIGH-ABQ-2611180459, WXHIGH-ANC-2611180459, WXHIGH-ATL-2611180459). Sports was not scanned (its list is over 15 MB) but has many daily events. |
| 9 | Which sandbox WebSocket host is correct? | **yes** | wss://ws.gemini.com: connected, subscribe acknowledged, 6 messages. wss://ws.sandbox.gemini.com: connected, subscribe acknowledged, 6 messages. wss://api.sandbox.gemini.com: failed (connection failed). Use wss://ws.sandbox.gemini.com. |
| ws | What do the public bookTicker and index price streams send? | **yes** | Subscribed on wss://ws.gemini.com to GEMI-BTC15M2611170815-UP@bookTicker and lukka:LS-LRRR-XBTUSD@indexPrice. bookTicker: {"u":1764531716425428,"E":1794902440646337394,"s":"gemi-btc15m2611170815-up","b":"0.4100","B":"10.00","a":"0.4900","A":"13.00"}. Index price: {"e":"thirdPartyPrice","E":1794902438,"s":"btcusd","I":"LRRR_XBT","p":"64677.91733333333","P":"","x":null,"u":30759}. |
| 10 | Which Arc testnet RPC host answers, and is the USDC address correct? | **yes** | https://rpc.testnet.arc.io: chain ID 5042002, USDC decimals() 6. https://rpc.testnet.arc.network: chain ID 5042002, USDC decimals() 6. USDC at 0x3600000000000000000000000000000000000000. |
| 11 | Does a Circle smart contract account on Arc testnet transact without holding gas? | **needs a person** | Needs a Circle API key and entity secret. The SDK (10.8.1) has createWallets, createContractExecutionTransaction and the blockchain identifier ARC-TESTNET. Check in Phase 4, or ask Circle at office hours. |
| 12 | Do the X selectors still match? | **needs a person** | Needs a signed-in browser: inspect a post for article[data-testid="tweet"] and [data-testid="tweetText"]. |
| sdk | Do the Gemini and Circle SDK packages exist on npm under the documented names? | **yes** | @gemini-markets/sdk@0.1.1, @circle-fin/developer-controlled-wallets@10.8.1. |
| lag | How long after expiry does Gemini set resolutionSide? | **yes** | Last 50 settled events. Short crypto windows (50): min 5.5s, median 5.6s, max 6.1s. All contracts (50): min 5.5s, median 5.6s, max 6.1s. |
| strike | When is the strike of a 15-minute contract available? | **yes** | BTC15M2611170815: value 64671.71 (availableAt 2026-11-17T08:00:00.000Z). BTC15M2611170830: value absent (availableAt 2026-11-17T08:15:00.000Z). The strike appears when the window opens, 15 minutes before expiry. |
<!-- verify:end -->

## Still open, and who can close it

| # | Question | What is needed |
| --- | --- | --- |
| 1 | Can orders be placed in the sandbox? | A Gemini sandbox account and an API key with the Trader role, then `pnpm verify:gemini --order` |
| 4 | Is an order's `price` for `outcome: "no"` the NO price? | The same sandbox order. The script buys 1 NO contract at the quoted NO ask and prints the fill |
| 5 | Fees on prediction market orders | The fill from that order, or Gemini at office hours |
| 3 | Full OAuth flow in the sandbox | Register an OAuth app at `https://exchange.sandbox.gemini.com/settings/api`. The authorize and token paths exist |
| 11 | Does a Circle smart contract account on Arc testnet need gas? | A Circle API key and entity secret (Phase 4), or Circle at office hours |
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
