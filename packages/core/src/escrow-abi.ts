/**
 * The TipEscrow contract's interface (contracts/src/TipEscrow.sol), written out by hand for
 * viem. Keep it in step with the Solidity source: `forge inspect TipEscrow abi` prints the
 * authoritative version.
 *
 * The contract uses USDC's 6-decimal ERC-20 interface only. Arc's native balance of the
 * same token has 18 decimals; never mix the two scales.
 */
export const TIP_ESCROW_ABI = [
  {
    type: 'function',
    name: 'registerThesis',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'author', type: 'address' },
      { name: 'marketId', type: 'bytes32' },
      { name: 'sideYes', type: 'bool' },
      { name: 'contentHash', type: 'bytes32' },
      { name: 'expiry', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'tip',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reportOutcome',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketId', type: 'bytes32' },
      { name: 'yesWon', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reportVoid',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'marketId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'refund',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'tipper', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'theses',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'author', type: 'address' },
      { name: 'marketId', type: 'bytes32' },
      { name: 'contentHash', type: 'bytes32' },
      { name: 'expiry', type: 'uint64' },
      { name: 'sideYes', type: 'bool' },
      { name: 'settled', type: 'bool' },
      { name: 'totalTips', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'marketState',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'tipOf',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'tipper', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  { type: 'function', name: 'MAX_TIP', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'TIMEOUT', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  { type: 'function', name: 'usdc', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'registrar', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'resolver', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  {
    type: 'event',
    name: 'ThesisRegistered',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'author', type: 'address', indexed: true },
      { name: 'marketId', type: 'bytes32', indexed: true },
      { name: 'sideYes', type: 'bool', indexed: false },
      { name: 'contentHash', type: 'bytes32', indexed: false },
      { name: 'expiry', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Tipped',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'tipper', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OutcomeReported',
    inputs: [
      { name: 'marketId', type: 'bytes32', indexed: true },
      { name: 'state', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AuthorPaid',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'author', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Refunded',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'tipper', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** The contract's MarketState enum, in order. */
export const MARKET_STATES = ['open', 'yesWon', 'noWon', 'void'] as const;

/** Arc testnet's public RPC nodes. Both answered with chain ID 5042002 in Phase 0. */
export const ARC_PUBLIC_RPC_URLS = ['https://rpc.testnet.arc.io', 'https://rpc.testnet.arc.network'] as const;

/**
 * The Arc RPC nodes to use, in order: the configured one first (`ARC_RPC_URL`, meant to be a
 * dedicated QuickNode endpoint), then Arc's public nodes as fallbacks, so losing one
 * provider slows a call down instead of failing it.
 */
export function arcRpcUrls(configured?: string | null): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of [configured?.trim(), ...ARC_PUBLIC_RPC_URLS]) {
    if (!url) continue;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

/**
 * Hides the path of every given RPC URL in a message. A QuickNode URL carries its access
 * token in the path, and viem puts the URL in its error messages, which end up in logs.
 */
export function redactRpcUrls(message: string, urls: readonly string[]): string {
  let out = message;
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.pathname.replace(/\/+/g, '') === '' && !parsed.search) continue;
    const hidden = `${parsed.origin}/[hidden]`;
    for (const form of [url, url.replace(/\/+$/, '')]) out = out.split(form).join(hidden);
  }
  return out;
}
