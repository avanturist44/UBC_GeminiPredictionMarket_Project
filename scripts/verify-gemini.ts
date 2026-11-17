/**
 * Phase 0: checks every item the build plan marks "Verify" against the live services,
 * before any code depends on it.
 *
 *   pnpm verify:gemini                 run the checks that need no account, print a table
 *   pnpm verify:gemini --write         also refresh the results table in docs/gemini-findings.md
 *   pnpm verify:gemini --order         also place ONE small order in Gemini's SANDBOX
 *                                      (needs GEMINI_SANDBOX_API_KEY and GEMINI_SANDBOX_API_SECRET;
 *                                      add --accept-terms after reading Gemini's terms)
 *   pnpm verify:gemini --by=2026-11-20T08:00:00Z   deadline used for "resolves by Thursday"
 *
 * Nothing here can touch real money: the only order call is hard-wired to the sandbox.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HmacAuth, createClient } from '@gemini-markets/sdk/server';
import {
  createGeminiPublicClient,
  rollingEventTickers,
  type GeminiEvent,
  type GeminiPublicClient,
} from '@thesis/core';

type Status = 'yes' | 'no' | 'partly' | 'needs a person' | 'error';
interface Result {
  item: string;
  question: string;
  status: Status;
  detail: string;
}

const PROD_REST = 'https://api.gemini.com';
const SANDBOX_REST = 'https://api.sandbox.gemini.com';
const WS_HOSTS = ['wss://ws.gemini.com', 'wss://ws.sandbox.gemini.com', 'wss://api.sandbox.gemini.com'];
const ARC_RPCS = ['https://rpc.testnet.arc.io', 'https://rpc.testnet.arc.network'];
const ARC_CHAIN_ID = 5042002;
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const FINDINGS_PATH = fileURLToPath(new URL('../docs/gemini-findings.md', import.meta.url));

const args = new Set(process.argv.slice(2).filter((a) => !a.startsWith('--by=')));
const byArg = process.argv.find((a) => a.startsWith('--by='))?.slice(5);
// End of Thursday, November 19, 2026 in Pacific time.
const deadline = new Date(byArg ?? '2026-11-20T08:00:00Z');

const quiet = { warn: () => {} };
const prod = createGeminiPublicClient({ baseUrl: PROD_REST, logger: quiet });
const sandbox = createGeminiPublicClient({ baseUrl: SANDBOX_REST, logger: quiet });

const short15 = (asset: string, count: number) =>
  rollingEventTickers({ prefix: `${asset}15M`, periodMinutes: 15, offsetMinutes: 0, count }, new Date());

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function sandboxEvents(): Promise<Result> {
  const list = await sandbox.listEvents({ status: 'active', limit: 500 });
  const categories = [...new Set(list.data.map((e) => e.category))].join(', ');
  return {
    item: '1',
    question: 'Does the sandbox list prediction market events, and can orders be placed there?',
    status: list.data.length > 0 ? 'partly' : 'no',
    detail:
      list.data.length > 0
        ? `Listing: yes, ${list.pagination.total ?? list.data.length} active events (${categories}). ` +
          'Order placement is not checked without a sandbox API key: run with --order.'
        : 'The sandbox returned no active events.',
  };
}

async function symbolsMatch(): Promise<Result> {
  const lines: string[] = [];
  let mismatches = 0;
  for (const ticker of [...short15('BTC', 1), ...short15('ETH', 1)]) {
    const [p, s] = await Promise.all([prod.getEvent(ticker), sandbox.getEvent(ticker)]);
    const [pc, sc] = [p?.contracts[0], s?.contracts[0]];
    const same =
      pc !== undefined &&
      pc.instrumentSymbol === sc?.instrumentSymbol &&
      (pc.strike?.value ?? null) === (sc.strike?.value ?? null);
    if (!same) mismatches += 1;
    lines.push(`${ticker}: symbol and strike ${same ? 'match' : 'DIFFER'} (strike ${pc?.strike?.value ?? 'pending'})`);
  }
  const settled = (await prod.listRecentlySettled()).data.filter((e) => /15M/.test(e.ticker)).slice(0, 4);
  for (const event of settled) {
    const other = await sandbox.getEvent(event.ticker);
    const same = other?.contracts[0]?.resolutionSide === event.contracts[0]?.resolutionSide;
    if (!same) mismatches += 1;
    lines.push(
      `${event.ticker}: production resolved ${event.contracts[0]?.resolutionSide}, ` +
        `sandbox ${other?.contracts[0]?.resolutionSide ?? 'not resolved'}`,
    );
  }
  return {
    item: '2',
    question: 'Do sandbox symbols and resolutions match production?',
    status: mismatches === 0 ? 'yes' : 'no',
    detail: `${lines.join('. ')}. Prices differ: sandbox books are made by bots.`,
  };
}

async function oauthPaths(): Promise<Result> {
  const base = 'https://exchange.sandbox.gemini.com';
  const query = new URLSearchParams({
    client_id: 'phase0-probe',
    response_type: 'code',
    redirect_uri: 'https://example.com/callback',
    state: 'probe',
    scope: 'orders:create,orders:read',
  });
  const authorize = await fetch(`${base}/auth?${query}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const location = authorize.headers.get('location') ?? '';
  const token = await fetch(`${base}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: 'probe',
      client_id: 'phase0-probe',
      client_secret: 'probe',
      redirect_uri: 'https://example.com/callback',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokenBody = (await token.text()).slice(0, 120);
  const exists = authorize.status >= 300 && authorize.status < 400 && /signin/.test(location) && token.status === 401;
  return {
    item: '3',
    question: 'Do the OAuth authorize and token paths work on exchange.sandbox.gemini.com?',
    status: exists ? 'partly' : 'no',
    detail:
      `GET /auth returned ${authorize.status} to ${location.split('?')[0] || '(no redirect)'}. ` +
      `POST /auth/token returned ${token.status} ${tokenBody}. ` +
      (exists
        ? 'Both paths exist and behave like production. The full flow needs a registered sandbox app.'
        : 'The paths did not behave like an OAuth endpoint.'),
  };
}

function quotedContracts(events: GeminiEvent[]) {
  return events
    .flatMap((e) => e.contracts)
    .filter((c) => c.prices?.bestBid && c.prices.bestAsk && c.prices.buy?.no && c.prices.sell?.no);
}

async function noPriceConvention(crypto: GeminiEvent[]): Promise<Result> {
  const contracts = quotedContracts(crypto);
  // Compare in integer cents to avoid float noise.
  const cents = (value: string | null | undefined) => Math.round(Number(value) * 100);
  const consistent = contracts.filter(
    (c) =>
      cents(c.prices?.buy?.no) === 100 - cents(c.prices?.bestBid) &&
      cents(c.prices?.sell?.no) === 100 - cents(c.prices?.bestAsk),
  );
  const sample = contracts[0];
  return {
    item: '4',
    question: 'For outcome "no", is price the price of NO?',
    status: 'partly',
    detail:
      `Quotes: ${consistent.length} of ${contracts.length} two-sided contracts have buy.no = 1 - bestBid and ` +
      `sell.no = 1 - bestAsk` +
      (sample
        ? ` (for example ${sample.instrumentSymbol}: bid ${sample.prices?.bestBid}, ask ${sample.prices?.bestAsk}, ` +
          `buy.no ${sample.prices?.buy?.no}, sell.no ${sample.prices?.sell?.no})`
        : '') +
      '. So Gemini quotes NO at its own price. Whether an order\'s `price` follows the same convention ' +
      'needs one sandbox order: run with --order. Until then the adapter should convert explicitly.',
  };
}

function fees(): Result {
  return {
    item: '5',
    question: 'What are the fees on prediction market orders?',
    status: 'needs a person',
    detail:
      'Not in the public API. The SDK exposes maker-rebate endpoints, so a maker fee exists. ' +
      'Ask Gemini at office hours or read the fill from --order. Paper mode models zero fees and says so.',
  };
}

async function priceHistory(crypto: GeminiEvent[]): Promise<Result> {
  const [ticker] = short15('BTC', 1);
  const detail = await prod.getEvent(ticker!);
  const has = (events: GeminiEvent[], key: string) =>
    events.some((e) => key in e || e.contracts.some((c) => key in c));
  const inDetail = detail ? has([detail], 'priceHistory') : false;
  const inList = has(crypto, 'priceHistory');
  const books = (detail ? has([detail], 'contractOrderbooks') : false) || has(crypto, 'contractOrderbooks');
  return {
    item: '6',
    question: 'Is priceHistory filled for short contracts, and at what interval?',
    status: inDetail || inList ? 'yes' : 'no',
    detail:
      `priceHistory present in the ${ticker} response: ${inDetail}; in the active Crypto list: ${inList}. ` +
      `contractOrderbooks present anywhere: ${books}. ` +
      (inDetail || inList
        ? 'Inspect the interval before relying on it.'
        : 'Charts start when recording started, and ask size for paper fills must come from the WebSocket.'),
  };
}

function shortAssets(crypto: GeminiEvent[]): Result {
  const assets = (window: string) =>
    [...new Set(crypto.map((e) => e.ticker.match(new RegExp(`^([A-Z]+)${window}\\d{10}$`))?.[1]).filter(Boolean))].sort();
  const fifteen = assets('15M');
  return {
    item: '7',
    question: 'Which assets have 15-minute events right now?',
    status: fifteen.length > 0 ? 'yes' : 'no',
    detail: `15-minute: ${fifteen.join(', ') || 'none'}. 5-minute: ${assets('05M').join(', ') || 'none'}.`,
  };
}

async function nonCryptoByDeadline(categories: string[]): Promise<Result> {
  const skip = new Set(['Crypto', 'Sports', 'Live']);
  const found: string[] = [];
  for (const category of categories.filter((c) => !skip.has(c))) {
    const list = await prod.listEvents({ status: 'active', category, limit: 500 });
    const soon = list.data.filter((e) => e.expiryDate && new Date(e.expiryDate) <= deadline);
    if (soon.length > 0) {
      const examples = soon.slice(0, 3).map((e) => e.ticker).join(', ');
      found.push(`${category}: ${soon.length} of ${list.data.length} (for example ${examples})`);
    }
  }
  return {
    item: '8',
    question: `Are there non-crypto markets that resolve by ${deadline.toISOString()}?`,
    status: found.length > 0 ? 'yes' : 'no',
    detail:
      found.length > 0
        ? `${found.join('. ')}. Sports was not scanned (its list is over 15 MB) but has many daily events.`
        : 'None outside Sports. The news agent would trade daily crypto contracts.',
  };
}

interface WsProbe {
  url: string;
  open: boolean;
  ack: boolean;
  messages: string[];
  error?: string;
}

function probeWebSocket(url: string, streams: string[], waitMs = 8000): Promise<WsProbe> {
  return new Promise((resolve) => {
    const probe: WsProbe = { url, open: false, ack: false, messages: [] };
    let socket: WebSocket;
    const finish = () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(probe);
    };
    const timer = setTimeout(finish, waitMs);
    try {
      socket = new WebSocket(url);
    } catch (error) {
      probe.error = describeError(error);
      clearTimeout(timer);
      resolve(probe);
      return;
    }
    socket.onopen = () => {
      probe.open = true;
      socket.send(JSON.stringify({ id: '1', method: 'SUBSCRIBE', params: streams }));
    };
    socket.onmessage = (event) => {
      const text = String(event.data);
      if (/"status":200/.test(text)) probe.ack = true;
      else if (probe.messages.length < 6) probe.messages.push(text.slice(0, 220));
    };
    socket.onerror = () => {
      probe.error ??= 'connection failed';
    };
    socket.onclose = finish;
  });
}

async function webSockets(): Promise<Result[]> {
  const [ticker] = short15('BTC', 1);
  const event = await prod.getEvent(ticker!);
  const symbol = event?.contracts[0]?.instrumentSymbol ?? `GEMI-${ticker}-UP`;
  const source = event?.sourceDetails;
  const indexStream = source?.agency && source.index ? `${source.agency}:${source.index}@indexPrice` : null;
  const streams = [`${symbol}@bookTicker`, ...(indexStream ? [indexStream] : [])];
  const probes = await Promise.all(WS_HOSTS.map((url) => probeWebSocket(url, streams)));
  const line = (p: WsProbe) =>
    `${p.url}: ${p.open ? `connected, subscribe ${p.ack ? 'acknowledged' : 'not acknowledged'}, ${p.messages.length} messages` : `failed (${p.error ?? 'no connection'})`}`;
  const sandboxOk = probes.filter((p) => p.url.includes('sandbox') && p.open && p.ack).map((p) => p.url);
  const prodProbe = probes[0]!;
  const book = prodProbe.messages.find((m) => /"b":/.test(m) && /"a":/.test(m));
  const index = prodProbe.messages.find((m) => /thirdPartyPrice/.test(m));
  return [
    {
      item: '9',
      question: 'Which sandbox WebSocket host is correct?',
      status: sandboxOk.length > 0 ? 'yes' : 'no',
      detail: `${probes.map(line).join('. ')}. Use ${sandboxOk.join(' or ') || 'REST polling'}.`,
    },
    {
      item: 'ws',
      question: 'What do the public bookTicker and index price streams send?',
      status: book ? 'yes' : 'partly',
      detail:
        `Subscribed on ${prodProbe.url} to ${streams.join(' and ')}. ` +
        `bookTicker: ${book ?? 'no message in the window (empty book)'}. ` +
        `Index price: ${index ?? 'no message in the window'}.`,
    },
  ];
}

async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as { result?: string; error?: { message: string } };
  if (body.result === undefined) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body.result;
}

async function arc(): Promise<Result> {
  const lines: string[] = [];
  let working = 0;
  for (const url of ARC_RPCS) {
    try {
      const chainId = Number.parseInt(await rpc(url, 'eth_chainId', []), 16);
      // decimals() selector 0x313ce567
      const decimals = Number.parseInt(await rpc(url, 'eth_call', [{ to: ARC_USDC, data: '0x313ce567' }, 'latest']), 16);
      const ok = chainId === ARC_CHAIN_ID && decimals === 6;
      if (ok) working += 1;
      lines.push(`${url}: chain ID ${chainId}, USDC decimals() ${decimals}${ok ? '' : ' UNEXPECTED'}`);
    } catch (error) {
      lines.push(`${url}: failed (${describeError(error)})`);
    }
  }
  return {
    item: '10',
    question: 'Which Arc testnet RPC host answers, and is the USDC address correct?',
    status: working > 0 ? 'yes' : 'no',
    detail: `${lines.join('. ')}. USDC at ${ARC_USDC}.`,
  };
}

async function packages(): Promise<Result> {
  const lines: string[] = [];
  let ok = 0;
  for (const name of ['@gemini-markets/sdk', '@circle-fin/developer-controlled-wallets']) {
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const body = (await response.json()) as { version: string };
      ok += 1;
      lines.push(`${name}@${body.version}`);
    } else {
      lines.push(`${name}: HTTP ${response.status}`);
    }
  }
  return {
    item: 'sdk',
    question: 'Do the Gemini and Circle SDK packages exist on npm under the documented names?',
    status: ok === 2 ? 'yes' : 'no',
    detail: `${lines.join(', ')}.`,
  };
}

async function resolutionLag(): Promise<Result> {
  const list = await prod.listRecentlySettled();
  const lags = list.data
    .flatMap((e) =>
      e.contracts.map((c) =>
        c.resolvedAt && (c.expiryDate ?? e.expiryDate)
          ? (new Date(c.resolvedAt).getTime() - new Date((c.expiryDate ?? e.expiryDate)!).getTime()) / 1000
          : null,
      ),
    )
    .filter((lag): lag is number => lag !== null)
    .sort((a, b) => a - b);
  const short = list.data
    .filter((e) => /(05|15)M/.test(e.ticker))
    .map((e) => (new Date(e.contracts[0]!.resolvedAt!).getTime() - new Date(e.expiryDate!).getTime()) / 1000)
    .sort((a, b) => a - b);
  const stats = (values: number[]) =>
    values.length === 0
      ? 'none'
      : `min ${values[0]!.toFixed(1)}s, median ${values[Math.floor(values.length / 2)]!.toFixed(1)}s, max ${values.at(-1)!.toFixed(1)}s`;
  return {
    item: 'lag',
    question: 'How long after expiry does Gemini set resolutionSide?',
    status: lags.length > 0 ? 'yes' : 'error',
    detail: `Last ${list.data.length} settled events. Short crypto windows (${short.length}): ${stats(short)}. All contracts (${lags.length}): ${stats(lags)}.`,
  };
}

async function strikeTiming(): Promise<Result> {
  const [current, next] = short15('BTC', 2);
  const [now, later] = [await prod.getStrike(current!), await prod.getStrike(next!)];
  return {
    item: 'strike',
    question: 'When is the strike of a 15-minute contract available?',
    status: now?.value ? 'yes' : 'partly',
    detail:
      `${current}: value ${now?.value ?? 'absent'} (availableAt ${now?.availableAt}). ` +
      `${next}: value ${later?.value ?? 'absent'} (availableAt ${later?.availableAt}). ` +
      'The strike appears when the window opens, 15 minutes before expiry.',
  };
}

function needsPerson(): Result[] {
  return [
    {
      item: '11',
      question: 'Does a Circle smart contract account on Arc testnet transact without holding gas?',
      status: 'needs a person',
      detail:
        'Needs a Circle API key and entity secret. The SDK (10.8.1) has createWallets, ' +
        'createContractExecutionTransaction and the blockchain identifier ARC-TESTNET. Check in Phase 4, or ask Circle at office hours.',
    },
    {
      item: '12',
      question: 'Do the X selectors still match?',
      status: 'needs a person',
      detail: 'Needs a signed-in browser: inspect a post for article[data-testid="tweet"] and [data-testid="tweetText"].',
    },
  ];
}

/** Places one small order in the SANDBOX to settle items 1, 4 and 5. */
async function sandboxOrder(): Promise<Result> {
  const item = 'order';
  const question = 'Can a prediction market order be placed in the sandbox, and how is a NO order priced?';
  const apiKey = process.env.GEMINI_SANDBOX_API_KEY;
  const apiSecret = process.env.GEMINI_SANDBOX_API_SECRET;
  if (!apiKey || !apiSecret) {
    return { item, question, status: 'needs a person', detail: 'Set GEMINI_SANDBOX_API_KEY and GEMINI_SANDBOX_API_SECRET (Trader role) in .env.' };
  }
  // The environment is fixed here on purpose. There is no production order path in this repo.
  const gemini = await createClient({ env: 'sandbox', auth: new HmacAuth({ apiKey, apiSecret }) });
  const terms = await gemini.predictions.getPredictionMarketsTermsStatus();
  if (!terms.hasAcceptedLatest) {
    if (!args.has('--accept-terms')) {
      return { item, question, status: 'needs a person', detail: 'The sandbox account has not accepted the prediction market terms. Read them on exchange.sandbox.gemini.com, then re-run with --order --accept-terms.' };
    }
    await gemini.predictions.acceptTerms();
  }
  const [ticker] = short15('BTC', 1);
  const event = await sandbox.getEvent(ticker!);
  const contract = event?.contracts[0];
  const noAsk = contract?.prices?.buy?.no;
  if (!contract || !noAsk) {
    return { item, question, status: 'error', detail: `No two-sided sandbox quote on ${ticker}. Try again in a minute.` };
  }
  const order = await gemini.predictions.placeOrder({
    symbol: contract.instrumentSymbol,
    orderType: 'limit',
    side: 'buy',
    outcome: 'no',
    quantity: '1',
    price: noAsk,
    timeInForce: 'immediate-or-cancel',
    makerOrCancel: false,
  });
  const json = JSON.stringify(order, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  return {
    item,
    question,
    status: 'yes',
    detail:
      `Sent buy NO, quantity 1, price ${noAsk} (the quoted NO ask; YES bid was ${contract.prices?.bestBid}) on ${contract.instrumentSymbol}. ` +
      `Response: ${json}. If it filled near ${noAsk}, price is the NO price. Read any fee fields for item 5.`,
  };
}

async function safely(item: string, question: string, run: () => Promise<Result | Result[]>): Promise<Result[]> {
  try {
    return [await run()].flat();
  } catch (error) {
    return [{ item, question, status: 'error', detail: describeError(error) }];
  }
}

function toMarkdown(results: Result[], ranAt: Date): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  return [
    `Last run: ${ranAt.toISOString()} by \`pnpm verify:gemini\`.`,
    '',
    '| # | Question | Answer | Detail |',
    '| --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.item} | ${cell(r.question)} | **${r.status}** | ${cell(r.detail)} |`),
  ].join('\n');
}

async function main() {
  const rootEnv = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const ranAt = new Date();
  console.error('Checking Gemini, Arc and npm. This takes about a minute...');

  // Shared inputs. The Crypto list is about 1 MB; the unfiltered list is over 25 MB.
  const crypto = (await prod.listEvents({ status: 'active', category: 'Crypto', limit: 500 })).data;
  const categories = await prod.getCategories();

  const results: Result[] = [
    ...(await safely('1', 'sandbox events', sandboxEvents)),
    ...(await safely('2', 'symbols match', symbolsMatch)),
    ...(await safely('3', 'OAuth paths', oauthPaths)),
    ...(await safely('4', 'NO price', () => noPriceConvention(crypto))),
    fees(),
    ...(await safely('6', 'priceHistory', () => priceHistory(crypto))),
    shortAssets(crypto),
    ...(await safely('8', 'non-crypto markets', () => nonCryptoByDeadline(categories))),
    ...(await safely('9', 'WebSocket hosts', webSockets)),
    ...(await safely('10', 'Arc RPC', arc)),
    ...needsPerson(),
    ...(await safely('sdk', 'npm packages', packages)),
    ...(await safely('lag', 'resolution lag', resolutionLag)),
    ...(await safely('strike', 'strike timing', strikeTiming)),
    ...(args.has('--order') ? await safely('order', 'sandbox order', sandboxOrder) : []),
  ];

  for (const r of results) {
    console.log(`\n[${r.item}] ${r.question}\n  ${r.status.toUpperCase()}: ${r.detail}`);
  }

  if (args.has('--write')) {
    const start = '<!-- verify:start -->';
    const end = '<!-- verify:end -->';
    const current = readFileSync(FINDINGS_PATH, 'utf8');
    const [before, rest] = current.split(start);
    const after = rest?.split(end)[1];
    if (before === undefined || after === undefined) {
      throw new Error(`${FINDINGS_PATH} is missing the ${start} / ${end} markers`);
    }
    writeFileSync(FINDINGS_PATH, `${before}${start}\n${toMarkdown(results, ranAt)}\n${end}${after}`);
    console.error(`\nUpdated ${FINDINGS_PATH}`);
  }

  const errors = results.filter((r) => r.status === 'error');
  if (errors.length > 0) {
    console.error(`\n${errors.length} check(s) errored: ${errors.map((r) => r.item).join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
