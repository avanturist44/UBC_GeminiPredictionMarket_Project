// Service worker: the only place that talks to the API. Content scripts ask it.
importScripts("constants.js", "mock.js");

const cardCache = new Map(); // symbol -> { at, card }

async function getJSON(path) {
  const res = await fetch(TM.API_BASE + path);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function loadMarkets() {
  const stored = (await chrome.storage.session.get("markets")).markets;
  if (stored && Date.now() - stored.at < TM.MARKETS_REFRESH_MS) return stored.data;
  try {
    const data = TM.USE_MOCK ? MOCK.markets : (await getJSON("/api/ext/markets")).markets;
    await chrome.storage.session.set({ markets: { at: Date.now(), data } });
    return data;
  } catch (e) {
    console.warn("[thesis-market] markets fetch failed", e);
    return stored ? stored.data : [];
  }
}

async function loadCard(symbol) {
  const hit = cardCache.get(symbol);
  if (hit && Date.now() - hit.at < TM.CARD_TTL_MS) return hit.card;
  try {
    const card = TM.USE_MOCK
      ? MOCK.cards[symbol] || null
      : await getJSON("/api/ext/card?symbol=" + encodeURIComponent(symbol));
    cardCache.set(symbol, { at: Date.now(), card });
    return card;
  } catch (e) {
    console.warn("[thesis-market] card fetch failed", e);
    return hit ? hit.card : null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "markets") loadMarkets().then(sendResponse);
  else if (msg.type === "card") loadCard(msg.symbol).then(sendResponse);
  else return false;
  return true; // keep the channel open for the async response
});
