// Renders the card inside a shadow root so X's CSS and ours never touch.
// All server text is inserted with textContent, never innerHTML.
//
// Two sections:
//   1. The single most trustworthy thesis -> links straight to that thesis (where copy trade lives)
//   2. A short summary of all theses on the market -> links to the market page
const TMCard = (() => {
  const CSS = `
  :host { all: initial; display: block; margin: 10px 0 4px; }
  .card { font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; border: 1px solid var(--line);
    border-radius: 14px; background: var(--bg); color: var(--fg); overflow: hidden; }
  .dark  { --bg:#16181c; --fg:#e7e9ea; --muted:#8b98a5; --line:#2f3336; --soft:#1d1f23; --accent:#7c9cff; }
  .light { --bg:#ffffff; --fg:#0f1419; --muted:#667785; --line:#e1e8ed; --soft:#f6f8fa; --accent:#3b5bdb; }
  .head { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid var(--line); }
  .brand { font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--accent); white-space:nowrap; }
  .title { flex:1; min-width:0; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .odds { font-weight:700; white-space:nowrap; }
  .odds small { color:var(--muted); font-weight:500; margin-right:3px; }
  .close { all:unset; cursor:pointer; color:var(--muted); font-size:16px; line-height:1; padding:2px 4px; border-radius:6px; }
  .close:hover { background:var(--soft); color:var(--fg); }
  .sec { padding:10px 12px; border-bottom:1px solid var(--line); }
  .label { font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin-bottom:6px; }
  .meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-bottom:5px; }
  .chip { font-size:10px; font-weight:700; letter-spacing:.05em; padding:1px 6px; border-radius:999px; background:var(--soft); color:var(--muted); border:1px solid var(--line); }
  .bet { font-size:11px; font-weight:700; padding:1px 7px; border-radius:999px; color:#fff; }
  .yes { background:#00ba7c; } .no { background:#f4212e; }
  .author { font-size:12px; color:var(--muted); }
  .author b { color:var(--fg); font-weight:600; }
  .headline { font-weight:600; margin-bottom:3px; }
  .excerpt { position:relative; color:var(--muted); max-height:3em; overflow:hidden; }
  .excerpt::after { content:""; position:absolute; left:0; right:0; bottom:0; height:1.6em;
    background:linear-gradient(to bottom, transparent, var(--bg)); }
  .cta { display:inline-block; margin-top:8px; text-decoration:none; font-weight:700; font-size:12px; color:#fff; background:var(--accent); padding:6px 12px; border-radius:999px; }
  .cta:hover { filter:brightness(1.1); }
  .more { display:inline-block; margin-top:6px; font-size:12px; font-weight:600; color:var(--accent); text-decoration:none; }
  .more:hover { text-decoration:underline; }
  .bar { display:flex; height:6px; border-radius:999px; overflow:hidden; background:var(--line); margin:2px 0 4px; }
  .bar .y { background:#00ba7c; } .bar .n { background:#f4212e; }
  .counts { font-size:11px; color:var(--muted); margin-bottom:6px; }
  .tldr { color:var(--fg); }
  .foot { padding:6px 12px; background:var(--soft); }
  .note { font-size:11px; color:var(--muted); }
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function isDark() {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
    if (!m) return true;
    return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 < 0.5;
  }

  const cents = (p) => Math.round(p * 100) + "¢";
  const pct = (p) => Math.round(p * 100) + "%";

  function truncate(s, max) {
    s = String(s || "");
    if (s.length <= max) return s;
    return s.slice(0, max).replace(/\s+\S*$/, "") + "…";
  }

  function link(cls, text, path) {
    const a = el("a", cls, text);
    a.href = new URL(path, TM.SITE_BASE).toString();
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function record(a) {
    if (!a || !a.resolved) return "No resolved calls yet";
    const early = a.resolved < 3 ? " (early)" : "";
    return a.correct + " of " + a.resolved + " right" + early;
  }

  // Section 1: the most trustworthy thesis. Its button goes to that exact thesis page.
  function topSection(t) {
    const sec = el("div", "sec");
    sec.append(el("div", "label", "Most trusted thesis"));

    const side = t.side === "NO" ? "no" : "yes";
    const meta = el("div", "meta");
    const author = el("span", "author");
    author.append(el("b", null, t.author.name), " · " + record(t.author));
    meta.append(
      el("span", "chip", t.author.kind === "agent" ? "AI" : "HUMAN"),
      el("span", "bet " + side, "Bets " + side.toUpperCase() + (t.entryPrice == null ? "" : " @ " + cents(t.entryPrice))),
      author
    );

    sec.append(
      meta,
      el("div", "headline", t.headline),
      el("div", "excerpt", truncate(t.excerpt, TM.EXCERPT_MAX_CHARS)),
      link("cta", "Read thesis & copy trade", "/thesis/" + encodeURIComponent(t.id) + "?src=ext")
    );
    return sec;
  }

  // Section 2: short summary across all theses. Its link goes to the market page, which
  // charts every thesis against the price.
  function summarySection(s, symbol) {
    const sec = el("div", "sec");
    sec.append(el("div", "label", "What " + s.thesisCount + " theses say"));

    const total = Math.max(1, s.yesCount + s.noCount);
    const bar = el("div", "bar");
    const y = el("div", "y");
    const n = el("div", "n");
    y.style.width = (s.yesCount / total) * 100 + "%";
    n.style.width = (s.noCount / total) * 100 + "%";
    bar.append(y, n);

    sec.append(
      bar,
      el("div", "counts", s.yesCount + " YES · " + s.noCount + " NO"),
      el("div", "tldr", truncate(s.text, TM.SUMMARY_MAX_CHARS)),
      link("more", "See every thesis on this market →", "/markets/" + encodeURIComponent(symbol) + "?src=ext")
    );
    return sec;
  }

  function mount(card, { onClose }) {
    const host = document.createElement("div");
    host.setAttribute("data-tm-card", card.symbol);
    const root = host.attachShadow({ mode: "open" });
    root.append(el("style", null, CSS));

    const wrap = el("div", "card " + (isDark() ? "dark" : "light"));

    const head = el("div", "head");
    const close = el("button", "close", "×");
    close.title = "Hide cards for this market";
    close.addEventListener("click", (e) => { e.preventDefault(); onClose(card.symbol); });
    const odds = el("div", "odds");
    odds.append(el("small", null, "YES"), card.yesPrice == null ? "–" : pct(card.yesPrice));
    head.append(el("span", "brand", "Thesis Market"), el("span", "title", card.title), odds, close);
    wrap.append(head);

    if (card.top) wrap.append(topSection(card.top));
    if (card.summary && card.summary.thesisCount >= TM.MIN_THESES_FOR_SUMMARY) {
      wrap.append(summarySection(card.summary, card.symbol));
    }

    const foot = el("div", "foot");
    foot.append(el("span", "note", card.mock ? "Sample data · test funds only" : "Test funds only"));
    wrap.append(foot);
    root.append(wrap);

    // X makes the whole post clickable; keep clicks on our card from navigating to the post.
    for (const evt of ["click", "mousedown", "pointerdown", "keydown"]) {
      host.addEventListener(evt, (e) => e.stopPropagation());
    }
    return host;
  }

  return { mount };
})();
