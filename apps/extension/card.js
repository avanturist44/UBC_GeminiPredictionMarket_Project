// Feed-sized market context. Shadow DOM isolates styles; server text stays inert.
const TMCard = (() => {
  const CSS = `
  :host { all:initial; display:block; margin:12px 0 4px; min-width:0; color-scheme:light dark; }
  * { box-sizing:border-box; }
  .card { --bg:#fff; --fg:#0f1419; --muted:#536471; --line:#cfd9de; --soft:#f7f9f9;
    --yes:#007a51; --no:#bc2636; --focus:#006baf;
    font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
    color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:8px;
    overflow:hidden; overflow-wrap:anywhere; font-weight:400; text-align:start; container-type:inline-size; }
  .dark { --bg:#000; --fg:#e7e9ea; --muted:#8b98a5; --line:#2f3336; --soft:#16181c;
    --yes:#43c99b; --no:#ff7a85; --focus:#71bfff; }
  .dim { --bg:#15202b; --fg:#f7f9f9; --muted:#a4b1bd; --line:#38444d; --soft:#1e2b38;
    --yes:#43c99b; --no:#ff7a85; --focus:#71bfff; }
  .head { display:flex; align-items:center; gap:8px; padding:8px 12px 0; color:var(--muted); font-size:12px; }
  .brand { font-weight:500; color:var(--fg); }
  .head .context { flex:1; }
  button,a,summary { -webkit-tap-highlight-color:transparent; }
  button { font:inherit; cursor:pointer; }
  .close { display:grid; place-items:center; width:28px; height:28px; padding:0; border:0;
    border-radius:4px; background:transparent; color:var(--muted); font-size:20px; line-height:1; }
  .close:hover,summary:hover { background:var(--soft); color:var(--fg); }
  .market { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:16px; align-items:center; padding:0 12px 12px; }
  .title { font-size:15px; line-height:1.4; font-weight:500; margin:0; }
  a { color:inherit; text-decoration:none; }
  a:hover { text-decoration:underline; text-underline-offset:3px; }
  a:focus-visible,button:focus-visible,summary:focus-visible { outline:2px solid var(--focus); outline-offset:2px; border-radius:2px; }
  .odds { text-align:end; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .odds .value { font-size:24px; line-height:1.15; font-weight:500; }
  .odds .value small { font-size:11px; margin-inline-start:4px; font-weight:400; }
  .odds .caption { display:block; color:var(--muted); font-size:11px; }
  .sec { border-top:1px solid var(--line); padding:8px 12px; }
  .label { color:var(--muted); font-size:12px; }
  .meta { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 8px; font-size:12px; margin-bottom:4px; }
  .bet { font-weight:500; font-variant-numeric:tabular-nums; }
  .yes { color:var(--yes); } .no { color:var(--no); }
  .author { color:var(--muted); }
  .headline { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden;
    font-size:13px; font-weight:500; line-height:1.5; }
  details { margin:0; }
  summary { cursor:pointer; min-height:32px; display:flex; align-items:center; gap:8px;
    font-size:12px; color:var(--muted); list-style:none; border-radius:4px; }
  summary::-webkit-details-marker { display:none; }
  summary::after { content:'+'; margin-inline-start:auto; font-size:16px; line-height:1; }
  details[open]>summary::after { content:'−'; }
  .excerpt,.tldr { margin:4px 0 8px; color:var(--muted); white-space:pre-line; }
  .record { font-size:12px; color:var(--muted); margin:8px 0; }
  .cta,.more { display:inline-flex; align-items:center; min-height:32px; font-size:12px; font-weight:500; }
  .cta { border:1px solid var(--line); border-radius:4px; padding:0 8px; margin-bottom:4px; }
  .cta:hover { background:var(--soft); text-decoration:none; }
  .summary-section { padding-top:4px; padding-bottom:4px; }
  .counts { display:flex; gap:8px; margin-inline-start:auto; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .bar { height:3px; display:flex; background:var(--line); margin:8px 0; }
  .bar .y { background:var(--yes); } .bar .n { background:var(--no); }
  .foot { border-top:1px solid var(--line); display:flex; flex-wrap:wrap; align-items:center;
    gap:4px 12px; padding:4px 12px; font-size:11px; color:var(--muted); }
  .foot .market-link { margin-inline-start:auto; min-height:28px; display:inline-flex; align-items:center; }
  @media (max-width:380px) { .market { gap:8px; } .odds .value { font-size:20px; } }
  @container (max-width:320px) {
    .market { grid-template-columns:minmax(0,1fr); gap:8px; }
    .odds { display:flex; align-items:baseline; gap:8px; text-align:start; }
    .odds .value { font-size:20px; }
  }
  `;
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function theme() {
    for (const node of [document.body, document.documentElement]) {
      const rgb = getComputedStyle(node).backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (!rgb || rgb[3] === 0) continue;
      const [r,g,b] = rgb;
      if ((.2126*r + .7152*g + .0722*b) / 255 >= .5) return 'light';
      return b > r + 8 ? 'dim' : 'dark';
    }
    return matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
  }
  function updateTheme(host) {
    const card = host.shadowRoot?.querySelector('.card');
    if (card) card.className = 'card ' + theme();
  }
  const validPrice = p => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
  const cents = p => Math.round(p * 100) + '¢';
  function link(cls, text, path, sample = false) {
    // Sample thesis IDs are not real routes or trade opportunities.
    if (sample) return el('span', cls, text);
    const node = el('a', cls, text);
    node.href = new URL(path, TM.SITE_BASE).toString();
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    return node;
  }
  function record(author) {
    if (!Number.isInteger(author?.resolved) || author.resolved <= 0) return 'No resolved calls yet';
    const correct = Number.isInteger(author.correct) ? author.correct + ' of ' : '';
    return correct + author.resolved + (correct ? ' calls correct' : ' resolved calls') + (author.resolved < 3 ? ' · early record' : '');
  }
  function topSection(thesis, sample) {
    const sec = el('section', 'sec');
    const side = thesis.side === 'NO' ? 'NO' : thesis.side === 'YES' ? 'YES' : null;
    const meta = el('div', 'meta');
    meta.append(el('span', 'label', 'Featured thesis'));
    if (side) meta.append(el('span', 'bet ' + side.toLowerCase(), side + (validPrice(thesis.entryPrice) ? ' @ ' + cents(thesis.entryPrice) : '')));
    const author = thesis.author;
    meta.append(el('span', 'author', (author?.name || 'Unknown author') + (author?.kind === 'agent' ? ' · AI' : author?.kind === 'human' ? ' · Human' : '')));
    const headline = link('headline', thesis.headline || 'Read the published thesis', '/thesis/' + encodeURIComponent(thesis.id) + '?src=ext', sample);
    headline.title = thesis.headline || '';
    const details = el('details', 'thesis-details');
    details.append(el('summary', null, 'Reasoning & author record'));
    if (thesis.excerpt) details.append(el('p', 'excerpt', thesis.excerpt));
    details.append(el('div', 'record', sample ? 'Sample author · ' + record(author) : record(author)),
      link('cta', 'Read thesis & copy trade', '/thesis/' + encodeURIComponent(thesis.id) + '?src=ext', sample));
    sec.append(meta, headline, details);
    return sec;
  }
  function summarySection(summary, symbol, sample) {
    const sec = el('section', 'sec summary-section');
    const details = el('details');
    const trigger = el('summary');
    trigger.append(el('span', null, summary.thesisCount + ' theses'));
    const counts = el('span', 'counts');
    const validCounts = [summary.yesCount, summary.noCount].every(n => Number.isInteger(n) && n >= 0);
    if (validCounts) counts.append(el('span', 'yes', summary.yesCount + ' YES'), el('span', 'no', summary.noCount + ' NO'));
    trigger.append(counts);
    details.append(trigger, el('div', 'label', 'Submitted thesis positions · not market probability'));
    const total = summary.yesCount + summary.noCount;
    if (validCounts && total > 0) {
      const bar = el('div', 'bar');
      bar.setAttribute('aria-hidden', 'true');
      const yes = el('span', 'y'), no = el('span', 'n');
      yes.style.width = summary.yesCount / total * 100 + '%';
      no.style.width = summary.noCount / total * 100 + '%';
      bar.append(yes, no); details.append(bar);
    }
    details.append(el('p', 'tldr', summary.text || 'No summary available'),
      link('more', 'Compare theses →', '/markets/' + encodeURIComponent(symbol) + '?src=ext', sample));
    sec.append(details);
    return sec;
  }
  function mount(card, {onClose}) {
    const host = el('div');
    host.dataset.tmCard = card.symbol;
    const root = host.attachShadow({mode:'open'});
    const wrap = el('div', 'card ' + theme());
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Thesis Market: ' + (card.title || card.symbol));
    const head = el('div', 'head');
    const close = el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Hide cards for this market');
    close.title = 'Hide cards for this market';
    close.addEventListener('click', e => { e.preventDefault(); onClose(card.symbol); });
    head.append(el('span', 'brand', 'Thesis Market'), el('span', 'context', card.mock ? 'Sample market' : 'Market context'), close);
    const market = el('div', 'market');
    const title = el('h3', 'title');
    title.append(link(null, card.title || card.symbol, '/markets/' + encodeURIComponent(card.symbol) + '?src=ext', card.mock));
    const odds = el('div', 'odds');
    const value = el('div', 'value', validPrice(card.yesPrice) ? Math.round(card.yesPrice * 100) + '%' : '—');
    value.append(el('small', null, 'YES'));
    odds.append(value, el('span', 'caption', card.mock ? 'Sample probability' : validPrice(card.yesPrice) ? 'Market probability' : 'Price unavailable'));
    market.append(title, odds);
    wrap.append(head, market);
    if (card.top) wrap.append(topSection(card.top, card.mock));
    if (card.summary?.thesisCount >= TM.MIN_THESES_FOR_SUMMARY) wrap.append(summarySection(card.summary, card.symbol, card.mock));
    const foot = el('div', 'foot');
    foot.append(el('span', null, card.mock ? 'Sample data · Test funds only' : 'Test funds only'),
      link('market-link', 'View market ↗', '/markets/' + encodeURIComponent(card.symbol) + '?src=ext', card.mock));
    wrap.append(foot);
    root.append(el('style', null, CSS), wrap);
    for (const event of ['click','mousedown','pointerdown','keydown']) host.addEventListener(event, e => e.stopPropagation());
    return host;
  }
  return {mount, updateTheme};
})();
