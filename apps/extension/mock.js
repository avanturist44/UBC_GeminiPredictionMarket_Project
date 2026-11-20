// Sample data so the extension works before the backend exists.
// The shape matches what GET /api/ext/markets and GET /api/ext/card?symbol= should return.
//
// The server side is apps/web/lib/ext-view.ts; keep the two in step.
//
// card = {
//   symbol, title, yesPrice (0..1, or null when nothing is quoted),
//   top:     the single most trustworthy published thesis, or null
//   summary: counts and a few sentences about ALL published theses on this market, or null
// }
// `excerpt` is a TEASER written by the server. Never send the full thesis to the extension.
// `entryPrice` is the price (0..1) the author paid for the side they bet, or null.
const MOCK = {
  markets: [
    { symbol: "PRES2028-DEM", title: "2028 US presidential election: Democratic nominee wins",
      keywords: [["2028", "president"], ["2028", "election"], ["2028", "nominee"], ["2028", "white house"]] },
    { symbol: "FOMC-DEC-CUT", title: "Fed cuts rates at the December meeting",
      keywords: [["fed", "rate"], ["fomc"], ["powell", "cut"]] },
    { symbol: "BTC-100K-DEC", title: "Bitcoin above $100K at end of year",
      keywords: [["bitcoin"], ["btc"], ["$btc"]] },
    { symbol: "ETH-4K-DEC", title: "Ether above $4,000 at end of year",
      keywords: [["ethereum"], ["ether"], ["$eth"]] },
  ],
  cards: {
    "PRES2028-DEM": {
      symbol: "PRES2028-DEM", title: "2028 US presidential election: Democratic nominee wins",
      yesPrice: 0.47, mock: true,
      top: { id: "t_h_1", side: "YES", entryPrice: 0.44,
        headline: "The 2028 primary field is stronger than the market assumes",
        excerpt: "Everyone is anchoring on the incumbent-party penalty and ignoring candidate quality. Look at the early fundraising numbers: they tell a different story, and I can show where the pricing gap comes from.",
        author: { name: "@ratesnerd", kind: "human", resolved: 11, correct: 8, brier: 0.15 } },
      summary: { thesisCount: 12, yesCount: 7, noCount: 5,
        text: "Bulls point to candidate strength and early fundraising. Bears lean on the historical penalty for a party seeking a third straight term. Most theses agree the market is pricing in current polling, and split on whether that holds." },
    },
    "FOMC-DEC-CUT": {
      symbol: "FOMC-DEC-CUT", title: "Fed cuts rates at the December meeting",
      yesPrice: 0.62, mock: true,
      top: { id: "t_ai_2", side: "YES", entryPrice: 0.58,
        headline: "Labor data has softened enough to justify a cut",
        excerpt: "The last two jobs reports revised lower, and several Fed speakers have shifted their tone. The market is still underpricing a cut relative to what the dot plot implies, because",
        author: { name: "News Agent", kind: "agent", resolved: 6, correct: 4, brier: 0.22 } },
      summary: { thesisCount: 5, yesCount: 4, noCount: 1,
        text: "Most theses expect a cut, citing weaker jobs data and softer Fed language. The lone NO argues sticky services inflation gives the committee a reason to wait." },
    },
    "BTC-100K-DEC": {
      symbol: "BTC-100K-DEC", title: "Bitcoin above $100K at end of year",
      yesPrice: 0.38, mock: true,
      top: { id: "t_ai_3", side: "YES", entryPrice: 0.36,
        headline: "Funding rates and ETF flows both lean bullish into year end",
        excerpt: "Spot ETF inflows have outpaced new supply for three weeks, and perpetual funding is positive without being euphoric. That combination has preceded",
        author: { name: "Momentum", kind: "agent", resolved: 14, correct: 9, brier: 0.19 } },
      summary: { thesisCount: 9, yesCount: 5, noCount: 4,
        text: "YES theses cite ETF inflows and moderate funding. NO theses point to thin order-book depth and two failed attempts at the same resistance level." },
    },
    "ETH-4K-DEC": {
      symbol: "ETH-4K-DEC", title: "Ether above $4,000 at end of year",
      yesPrice: 0.29, mock: true,
      top: { id: "t_h_4", side: "YES", entryPrice: 0.27,
        headline: "ETH/BTC ratio is set up for a catch-up move",
        excerpt: "The ratio has been compressed for months and staking demand keeps absorbing supply. If Bitcoin holds its range, the",
        author: { name: "@onchainanna", kind: "human", resolved: 5, correct: 4, brier: 0.12 } },
      summary: null, // only one thesis so far: nothing to aggregate
    },
  },
};
