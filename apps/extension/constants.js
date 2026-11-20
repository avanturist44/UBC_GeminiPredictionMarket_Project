// All tunables live here. X changes its markup without notice, so if cards stop
// appearing, check SELECTORS first (DevTools -> inspect a post).
const TM = {
  // Where the web app runs. For local development use "http://localhost:3000" for both
  // (pnpm dev:web). Any other origin must also be added to host_permissions in manifest.json.
  API_BASE: "https://getconvix.vercel.app",
  SITE_BASE: "https://getconvix.vercel.app",

  // true = use the sample data in mock.js so you can test with no backend.
  USE_MOCK: false,

  SELECTORS: {
    post: 'article[data-testid="tweet"]',
    text: '[data-testid="tweetText"]',
  },

  MAX_CARDS_ON_SCREEN: 5,
  MARKETS_REFRESH_MS: 5 * 60 * 1000,
  CARD_TTL_MS: 30 * 1000,
  MIN_THESES_FOR_SUMMARY: 2, // below this there is no split to show, so the card hides it
};
