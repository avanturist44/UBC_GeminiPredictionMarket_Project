// Pure matching. A post matches a market when EVERY term of at least one
// keyword group appears in it (case-insensitive, whole words).
// keywords: [["bitcoin"], ["btc"], ["fed","rate"]]
(function (root) {
  const cache = new Map();

  function termRegex(term) {
    let re = cache.get(term);
    if (!re) {
      const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp("(?<![a-z0-9_])" + escaped + "(?:s)?(?![a-z0-9_])", "i");
      cache.set(term, re);
    }
    return re;
  }

  // Returns how many terms the best-matching group has (0 = no match).
  function scoreMarket(text, keywords) {
    let best = 0;
    for (const group of keywords || []) {
      if (!group.length) continue;
      if (group.every((t) => termRegex(t).test(text))) best = Math.max(best, group.length);
    }
    return best;
  }

  // The most specific group wins; ties prefer the first market mentioned in the post.
  function bestMatch(text, markets) {
    let winner = null;
    let winnerScore = 0;
    let firstMention = Infinity;
    for (const m of markets) {
      const s = scoreMarket(text, m.keywords);
      const first = Math.min(...(m.keywords || []).filter(group => group.length && group.every(term => termRegex(term).test(text)))
        .flatMap(group => group.map(term => termRegex(term).exec(text).index)));
      if (s > winnerScore || (s > 0 && s === winnerScore && first < firstMention)) { winner = m; winnerScore = s; firstMention = first; }
    }
    return winner;
  }

  const api = { scoreMarket, bestMatch };
  root.TMMatch = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
