// Finds posts on x.com, matches them locally against tracked markets, mounts a card.
// Post text never leaves the browser: only the matched market's symbol is sent out.
(() => {
  const dismissed = new Set(); // market symbols hidden for this page session
  let markets = [];
  let marketsAt = 0;
  let scanTimer = null;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res));
      } catch (_) {
        resolve(null); // extension was reloaded; this content script is orphaned
      }
    });
  }

  async function ensureMarkets() {
    if (markets.length && Date.now() - marketsAt < TM.MARKETS_REFRESH_MS) return;
    markets = (await send({ type: "markets" })) || [];
    marketsAt = Date.now();
  }

  function onClose(symbol) {
    dismissed.add(symbol);
    document.querySelectorAll('[data-tm-card="' + CSS.escape(symbol) + '"]').forEach((n) => n.remove());
  }

  async function processPost(post) {
    const state = post.dataset.tmState;
    if (state === "pending" || state === "none") return;
    if (state === "card" && post.querySelector("[data-tm-card]")) return; // still mounted
    // state === "card" but host vanished (X re-rendered the post) falls through and remounts.

    const textEl = post.querySelector(TM.SELECTORS.text);
    if (!textEl) return;
    if (document.querySelectorAll("[data-tm-card]").length >= TM.MAX_CARDS_ON_SCREEN) return; // retry later

    post.dataset.tmState = "pending";
    await ensureMarkets();

    const match = TMMatch.bestMatch(
      textEl.innerText || "",
      markets.filter((m) => !dismissed.has(m.symbol))
    );
    if (!match) { post.dataset.tmState = "none"; return; }

    const card = await send({ type: "card", symbol: match.symbol });
    if (card && !card.top && !(card.summary && card.summary.thesisCount >= TM.MIN_THESES_FOR_SUMMARY)) {
      post.dataset.tmState = "none"; // a market with no theses yet has nothing to show
      return;
    }
    const anchor = post.querySelector(TM.SELECTORS.text);
    if (!card || !anchor || dismissed.has(match.symbol) || !post.isConnected) {
      post.dataset.tmState = card ? "" : "none";
      return;
    }
    anchor.insertAdjacentElement("afterend", TMCard.mount(card, { onClose }));
    post.dataset.tmState = "card";
  }

  function scan() {
    scanTimer = null;
    document.querySelectorAll(TM.SELECTORS.post).forEach(processPost);
  }

  new MutationObserver(() => {
    if (!scanTimer) scanTimer = setTimeout(scan, 300); // debounce: X mutates constantly
  }).observe(document.body, { childList: true, subtree: true });

  scan();
})();
