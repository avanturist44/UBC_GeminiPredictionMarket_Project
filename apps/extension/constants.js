// All tunables live here. X changes its markup without notice, so if cards stop
// appearing, check SELECTORS first (DevTools -> inspect a post).
const TM = {
  // Where your Next.js app runs. Change both when you deploy, and add the
  // deployed origin to host_permissions in manifest.json.
  API_BASE: "http://127.0.0.1:3000",
  SITE_BASE: "http://127.0.0.1:3000",

  // true = use the sample data in mock.js so you can test with no backend.
  USE_MOCK: false,

  SELECTORS: {
    post: 'article[data-testid="tweet"]',
    text: '[data-testid="tweetText"]',
  },

  MAX_CARDS_ON_SCREEN: 5,
  MARKETS_REFRESH_MS: 5 * 60 * 1000,
  CARD_TTL_MS: 30 * 1000,
  EXCERPT_MAX_CHARS: 180, // teaser; full reasoning stays on the website
  SUMMARY_MAX_CHARS: 240, // the TLDR shown on the card; the full summary lives on the website
  MIN_THESES_FOR_SUMMARY: 2, // below this there is nothing to aggregate, so hide the summary
};
