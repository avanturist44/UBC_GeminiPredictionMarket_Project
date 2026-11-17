# Gemini fixtures

Real responses from `https://api.gemini.com/v1/prediction-markets`, recorded on 2026-11-17 (UTC) during Phase 0.
They are used by the zod parsing tests and by the recorder tests. Do not edit values by hand.

| File | Request |
| --- | --- |
| `event-15m-live.json` | `GET /events/ETH15M2611170745` during its window: strike set, two-sided prices |
| `event-15m-pending.json` | `GET /events/BTC15M2611170745` before its window: no prices, strike without a value |
| `event-15m-settled.json` | `GET /events/BTC15M2611170700` after settlement |
| `event-daily-categorical.json` | The `BTC2611172200` event from the list response (10 `HI{PRICE}` contracts) |
| `event-binary-long.json` | The `RECESSION26` event from `GET /events?category=Economics` |
| `events-list-sample.json` | `GET /events?status=active&limit=500`, trimmed to 4 events. The sports event's nested `events` array is cut to its first item |
| `recently-settled-sample.json` | `GET /events/recently-settled`, first 4 events |
| `strike-ready.json`, `strike-pending.json` | `GET /events/{ticker}/strike` during and before the window |
