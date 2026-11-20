// Renders the card inside a shadow root so X's CSS and ours never touch.
// All server text is inserted with textContent, never innerHTML.
//
// One glance, three facts:
//   1. The market and its YES price, in the largest type on the card
//   2. The most trusted thesis: who, which side at what price, and its headline -> that thesis page
//   3. How every thesis splits, one dot each -> the market page
// The card is glass: a translucent surface with light along its rim, so it sits on X's
// timeline as a layer above the post rather than a box inside it.
const TMCard = (() => {
  const CSS = `
  :host { all: initial; display: block; margin: 12px 0 4px; }

  .card {
    position: relative; isolation: isolate; padding: 20px; border-radius: 24px;
    font: 400 15px/20px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    -webkit-font-smoothing: antialiased; color: var(--fg);
    background: var(--glass);
    -webkit-backdrop-filter: blur(24px) saturate(180%); backdrop-filter: blur(24px) saturate(180%);
    box-shadow: var(--shadow);
    animation: rise 280ms cubic-bezier(.2, .8, .2, 1) both;
  }
  /* The rim: light catching the edge of the glass, brightest at the top left. */
  .card::before {
    content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none;
    background: var(--rim);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude;
  }
  /* The sheen: the top of the glass catches a little more light than the rest. */
  .card::after {
    content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none;
    background: linear-gradient(180deg, var(--sheen), transparent 56px);
  }

  .dark {
    --fg: #f5f5f7; --fg2: #b4b4b9; --fg3: #98989d;
    --glass: linear-gradient(180deg, rgba(255,255,255,.085), rgba(255,255,255,.045));
    --rim: linear-gradient(150deg, rgba(255,255,255,.36), rgba(255,255,255,.08) 28%, rgba(255,255,255,.04) 64%, rgba(255,255,255,.18));
    --sheen: rgba(255,255,255,.045);
    --shadow: 0 1px 1px rgba(0,0,0,.4), 0 16px 40px -16px rgba(0,0,0,.8);
    --fill: rgba(255,255,255,.08); --fill-hover: rgba(255,255,255,.15); --fill-rim: rgba(255,255,255,.14);
    --yes: #4cc38a; --no: #f2555a; --yes-tint: rgba(76,195,138,.16); --no-tint: rgba(242,85,90,.16);
  }
  .light {
    --fg: #1d1d1f; --fg2: #515154; --fg3: #636367;
    --glass: linear-gradient(180deg, rgba(246,246,248,.9), rgba(238,239,242,.8));
    --rim: linear-gradient(150deg, #fff, rgba(255,255,255,.5) 30%, rgba(0,0,0,.05) 70%, rgba(0,0,0,.1));
    --sheen: rgba(255,255,255,.7);
    --shadow: 0 0 0 .5px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.06), 0 12px 32px -12px rgba(0,0,0,.2);
    --fill: rgba(0,0,0,.05); --fill-hover: rgba(0,0,0,.09); --fill-rim: rgba(255,255,255,.9);
    --yes: #136b45; --no: #b3242a; --yes-tint: rgba(36,160,100,.13); --no-tint: rgba(220,50,56,.11);
  }
  .card { --accent: #6d8bff; --accent-top: #8ba3ff; --on-accent: #0b0d14; }
  /* The site's serif, for the name and the thesis headline. One weight: never bolded. */
  .card { --serif: "convix digits", "convix serif", "Instrument Serif", ui-serif, Georgia, serif; }

  a, button { -webkit-tap-highlight-color: transparent; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .top { display: flex; align-items: center; gap: 8px; height: 24px; }
  .brand { display: inline-flex; align-items: center; color: var(--fg); }
  /* As on the site: the accent on the í is a notched arrowhead, sized in em to the name. */
  .wordmark .i { position: relative; display: inline-block; }
  .wordmark .acc { position: absolute; width: 0.28em; height: 0.28em; left: calc(50% - 0.13em); bottom: 0.66em; overflow: visible; }
  .wordmark { font-family: var(--serif); font-size: 18px; line-height: 1; font-weight: 400; font-synthesis: none; }
  .note { margin-left: auto; font-size: 12px; line-height: 16px; color: var(--fg3); white-space: nowrap; }
  .close {
    all: unset; box-sizing: border-box; flex: none; display: grid; place-items: center;
    width: 24px; height: 24px; margin-right: -4px; border-radius: 12px; cursor: pointer;
    background: var(--fill); color: var(--fg2); transition: background-color 160ms ease, color 160ms ease;
  }
  .close:hover { background: var(--fill-hover); color: var(--fg); }
  .close svg { width: 10px; height: 10px; }

  .market { display: flex; align-items: first baseline; gap: 16px; margin-top: 16px; }
  .title {
    flex: 1; min-width: 0; font-size: 17px; line-height: 22px; font-weight: 500;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
  }
  .odds { flex: none; text-align: right; }
  .pct { display: block; font-size: 28px; line-height: 32px; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .pct-label { display: block; font-size: 12px; line-height: 16px; color: var(--fg3); }
  .no-price { font-size: 13px; line-height: 20px; color: var(--fg3); }

  .thesis { display: grid; grid-template-columns: 32px minmax(0, 1fr); column-gap: 12px; margin-top: 20px; }
  .avatar {
    display: grid; place-items: center; width: 32px; height: 32px; border-radius: 16px;
    background: var(--fill); box-shadow: inset 0 1px 0 var(--fill-rim);
    font-size: 12px; font-weight: 600; color: var(--fg2);
  }
  .avatar.agent { border-radius: 10px; color: var(--accent); }
  .who { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 32px; }
  /* Name and record share a line while they fit; on a narrow column the record drops below. */
  .id { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; column-gap: 8px; }
  .name { min-width: 0; max-width: 100%; font-size: 14px; line-height: 20px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .record { min-width: 0; max-width: 100%; font-size: 13px; line-height: 20px; color: var(--fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .side {
    flex: none; margin-left: auto; display: inline-flex; align-items: center; height: 24px; padding: 0 10px;
    border-radius: 12px; font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .side.yes { color: var(--yes); background: var(--yes-tint); }
  .side.no { color: var(--no); background: var(--no-tint); }
  .headline {
    grid-column: 2; margin-top: 4px;
    font-family: var(--serif); font-size: 20px; line-height: 24px; font-weight: 400; font-synthesis: none;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
  }

  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 16px; margin-top: 20px; }
  .cta {
    display: inline-flex; align-items: center; height: 36px; padding: 0 16px; border-radius: 18px;
    font-size: 14px; font-weight: 600; text-decoration: none; white-space: nowrap; color: var(--on-accent);
    background: linear-gradient(180deg, var(--accent-top), var(--accent));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.45), inset 0 -1px 0 rgba(0,0,0,.12), 0 1px 2px rgba(0,0,0,.24);
    transition: transform 120ms cubic-bezier(.2, .8, .2, 1);
  }
  .cta:hover { --accent-top: #9cb0ff; --accent: #7d97ff; }
  .cta:active { transform: scale(.97); }
  .more {
    margin-left: auto; display: inline-flex; align-items: center; gap: 8px; height: 36px;
    font-size: 13px; line-height: 20px; color: var(--fg2); text-decoration: none; white-space: nowrap;
    transition: color 160ms ease;
  }
  .more:hover { color: var(--fg); }
  .more svg { width: 12px; height: 12px; margin-left: -4px; }
  .dots { display: inline-flex; gap: 4px; }
  .dot { width: 8px; height: 8px; border-radius: 4px; }
  .dot.yes, .bar .yes { background: var(--yes); }
  .dot.no, .bar .no { background: var(--no); }
  .bar { display: inline-flex; gap: 2px; width: 48px; height: 6px; border-radius: 3px; overflow: hidden; }

  /* X on a phone: a narrow column. Less padding, and the button takes the whole row. */
  :host { container-type: inline-size; }
  @container (max-width: 400px) {
    .card { padding: 16px; }
    .cta { flex: 1 1 100%; justify-content: center; }
    .more { margin: 0 auto; }
  }

  @keyframes rise { from { opacity: 0; transform: translateY(4px); } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } .cta { transition: none; } }
  `;

  // Up to this many theses get one dot each; more than that become a split bar.
  const MAX_DOTS = 10;
  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // A small static icon. Each shape is [tag, attributes].
  function icon(viewBox, shapes) {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", viewBox);
    s.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
      s.append(shape);
    }
    return s;
  }

  // The site's mark: a ring, the same one that marks an author's entry on every odds line.
  // The site's mark: the name, with the accent on the í drawn as a notched arrowhead over a
  // dotless ı, in the letters' own color.
  function wordmark() {
    const mark = el("span", "wordmark");
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", "convíx");
    const head = icon("0 0 100 100", [["polygon", { points: "92,18 51,71 56,43 28,38", fill: "currentColor" }]]);
    head.setAttribute("class", "acc");
    const i = el("span", "i", "ı");
    i.append(head);
    mark.append("conv", i, "x");
    return mark;
  }
  const cross = () => icon("0 0 10 10", [["path", { d: "M1.5 1.5l7 7M8.5 1.5l-7 7", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" }]]);
  const chevron = () => icon("0 0 12 12", [["path", { d: "M4.5 2.5L8 6l-3.5 3.5", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }]]);

  // The serif ships inside the extension and is registered from its bytes, so X's
  // content-security policy, which governs font URLs, never applies. A font added to the
  // page's font set is visible inside the card's shadow root. Until it loads, Georgia stands in.
  // As on the site, the digits come from Source Serif 4: Instrument Serif's 1 looks like an l.
  let serifRequested = false;
  function addFont(file, family, descriptors) {
    return fetch(chrome.runtime.getURL("fonts/" + file))
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.arrayBuffer();
      })
      .then((bytes) => new FontFace(family, bytes, descriptors).load())
      .then((face) => document.fonts.add(face))
      .catch((e) => console.warn("[convix] " + file + " did not load", e));
  }
  function loadSerif() {
    if (serifRequested) return;
    serifRequested = true;
    addFont("InstrumentSerif-Regular.woff2", "convix serif", {});
    addFont("SourceSerif4-Digits.woff2", "convix digits", { unicodeRange: "U+0030-0039" });
  }

  function isDark() {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
    if (!m) return true;
    return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 < 0.5;
  }

  const cents = (p) => Math.round(p * 100) + "¢";
  const pct = (p) => Math.round(p * 100) + "%";
  const theses = (n) => n + (n === 1 ? " thesis" : " theses");

  // As on the site: the first letters of the first two words, "Guest 1538" is G.
  function initials(name) {
    return String(name || "")
      .replace(/^@/, "")
      .split(/[\s_-]+/)
      .filter((part) => /^[a-z]/i.test(part))
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join("") || "?";
  }

  function link(cls, path) {
    const a = el("a", cls);
    a.href = new URL(path, TM.SITE_BASE).toString();
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function header(card, onClose) {
    const top = el("div", "top");
    const brand = el("span", "brand");
    brand.append(wordmark());
    const close = el("button", "close");
    close.type = "button";
    close.title = "Hide cards for this market";
    close.setAttribute("aria-label", "Hide cards for this market");
    close.append(cross());
    close.addEventListener("click", (e) => { e.preventDefault(); onClose(card.symbol); });
    top.append(brand, el("span", "note", card.mock ? "Sample data" : "Test funds"), close);
    return top;
  }

  // The market and its YES price. The price is the largest thing on the card.
  function market(card) {
    const row = el("div", "market");
    const odds = el("div", "odds");
    if (card.yesPrice == null) {
      odds.append(el("span", "no-price", "No price yet"));
    } else {
      odds.append(el("span", "pct", pct(card.yesPrice)), el("span", "pct-label", "Yes"));
    }
    row.append(el("div", "title", card.title), odds);
    return row;
  }

  // The most trusted thesis. Its side sits in the price column, under the market's price,
  // so the author's entry and today's price read as one comparison.
  function thesis(t) {
    const block = el("div", "thesis");
    const kind = t.author.kind === "agent" ? "agent" : "human";
    const avatar = el("span", "avatar " + kind, initials(t.author.name));
    avatar.setAttribute("aria-hidden", "true");

    const id = el("span", "id");
    id.append(el("span", "name", t.author.name));
    const record = [];
    if (kind === "agent") record.push("AI");
    if (t.author.resolved) record.push(t.author.correct + " of " + t.author.resolved + " right");
    if (record.length) id.append(el("span", "record", record.join(" · ")));
    const side = t.side === "NO" ? "No" : "Yes";
    const who = el("div", "who");
    who.append(id, el("span", "side " + side.toLowerCase(), t.entryPrice == null ? "Bets " + side : side + " at " + cents(t.entryPrice)));

    block.append(avatar, who, el("div", "headline", t.headline));
    return block;
  }

  // How every thesis splits, one dot each, linking to the market page that charts them all.
  function split(s, symbol) {
    const more = link("more", "/markets/" + encodeURIComponent(symbol) + "?src=ext");
    more.setAttribute("aria-label", theses(s.thesisCount) + ": " + s.yesCount + " Yes, " + s.noCount + " No. Open the market");
    more.title = s.yesCount + " Yes, " + s.noCount + " No";
    let mark;
    if (s.thesisCount <= MAX_DOTS) {
      mark = el("span", "dots");
      for (let i = 0; i < s.yesCount; i += 1) mark.append(el("span", "dot yes"));
      for (let i = 0; i < s.noCount; i += 1) mark.append(el("span", "dot no"));
    } else {
      mark = el("span", "bar");
      const total = Math.max(1, s.yesCount + s.noCount);
      const yes = el("span", "yes");
      const no = el("span", "no");
      yes.style.width = (s.yesCount / total) * 100 + "%";
      no.style.flex = "1";
      mark.append(yes, no);
    }
    mark.setAttribute("aria-hidden", "true");
    more.append(mark, theses(s.thesisCount), chevron());
    return more;
  }

  function mount(card, { onClose }) {
    loadSerif();
    const host = document.createElement("div");
    host.setAttribute("data-tm-card", card.symbol);
    const root = host.attachShadow({ mode: "open" });
    root.append(el("style", null, CSS));

    const wrap = el("div", "card " + (isDark() ? "dark" : "light"));
    wrap.append(header(card, onClose), market(card));
    if (card.top) wrap.append(thesis(card.top));

    const actions = el("div", "actions");
    if (card.top) {
      const cta = link("cta", "/thesis/" + encodeURIComponent(card.top.id) + "?src=ext");
      cta.textContent = "Read and copy trade";
      actions.append(cta);
    }
    if (card.summary && card.summary.thesisCount >= TM.MIN_THESES_FOR_SUMMARY) {
      actions.append(split(card.summary, card.symbol));
    }
    if (actions.childNodes.length) wrap.append(actions);
    root.append(wrap);

    // X makes the whole post clickable; keep clicks on our card from navigating to the post.
    for (const evt of ["click", "mousedown", "pointerdown", "keydown"]) {
      host.addEventListener(evt, (e) => e.stopPropagation());
    }
    return host;
  }

  return { mount };
})();
