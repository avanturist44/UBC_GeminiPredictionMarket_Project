import { parseAbi, defineChain } from 'viem';
export const ARC_CHAIN_ID = 5042002;
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;
export const arcTestnet = defineChain({ id: ARC_CHAIN_ID, name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Testnet Explorer', url: 'https://explorer.testnet.arc.io' } }, testnet: true });
export const escrowAbi = parseAbi([
  'function usdc() view returns (address)', 'function registrar() view returns (address)', 'function resolver() view returns (address)',
  'function marketState(bytes32) view returns (uint8)',
  'function theses(bytes32) view returns (address author, bytes32 marketId, bytes32 contentHash, uint64 expiry, bool sideYes, bool settled, uint128 totalTips)',
  'function tipOf(bytes32,address) view returns (uint256)', 'function usedTipRequest(bytes32) view returns (bool)',
  'function registerThesis(bytes32,address,bytes32,bool,bytes32,uint64)',
  'function tip(bytes32,uint256,bytes32)', 'function reportOutcome(bytes32,bool)', 'function reportVoid(bytes32)',
  'function settle(bytes32)', 'function refund(bytes32,address)',
  'event ThesisRegistered(bytes32 indexed id,address indexed author,bytes32 indexed marketId,bool sideYes,bytes32 contentHash,uint64 expiry)',
  'event Tipped(bytes32 indexed id,address indexed tipper,uint256 amount,bytes32 indexed requestId)',
  'event OutcomeReported(bytes32 indexed marketId,uint8 state)',
  'event AuthorPaid(bytes32 indexed id,address indexed author,uint256 amount)',
  'event Refunded(bytes32 indexed id,address indexed tipper,uint256 amount)',
]);
export const explorerTx = (hash: string) => /^0x[0-9a-f]{64}$/i.test(hash) ? `https://explorer.testnet.arc.io/tx/${hash}` : null;
/** ERC-20 USDC precision is SIX, separate from native Arc gas balances at eighteen. */
export function usdcUnits(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error('invalid USDC amount');
  const [whole = '0', part = ''] = value.split('.'); return BigInt(whole) * 1_000_000n + BigInt(part.padEnd(6, '0'));
}
export function usdcDecimal(value: bigint) { return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`; }
