import { MARKET_STATES, TIP_ESCROW_ABI } from '@thesis/core';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * The worker's access to the TipEscrow contract on Arc testnet, through the two privileged
 * keys it holds: the registrar records theses, the resolver reports market outcomes.
 * Neither key can move tips anywhere but to a thesis's author or back to its tipper;
 * the contract allows nothing else.
 *
 * Every write waits for its receipt and throws if the transaction reverted, so a caller
 * that gets a hash back knows the call took effect. Each write first reads the contract and
 * does nothing if the state is already what the call would produce, which is what makes
 * the worker's jobs safe to re-run.
 *
 * All amounts are USDC with 6 decimals (the ERC-20 interface). Test money only.
 */

export interface ChainSettings {
  rpcUrl: string;
  chainId: number;
  escrowAddress: Address;
  usdcAddress: Address;
  registrarKey: Hex;
  resolverKey: Hex;
}

export type MarketOutcome = (typeof MARKET_STATES)[number];

export interface OnchainThesis {
  author: Address;
  marketId: Hex;
  contentHash: Hex;
  expiry: bigint;
  sideYes: boolean;
  settled: boolean;
  totalTips: bigint;
}

export interface EscrowChain {
  readonly escrowAddress: Address;
  readonly usdcAddress: Address;
  /** Null when the contract has no thesis with this id. */
  thesis(id: Hex): Promise<OnchainThesis | null>;
  marketState(marketId: Hex): Promise<MarketOutcome>;
  tipOf(id: Hex, tipper: Address): Promise<bigint>;
  usdcBalance(owner: Address): Promise<bigint>;
  usdcAllowance(owner: Address): Promise<bigint>;
  /** Records a thesis. Returns null, sending nothing, if it is already recorded. */
  registerThesis(input: {
    id: Hex;
    author: Address;
    marketId: Hex;
    sideYes: boolean;
    contentHash: Hex;
    expiry: Date;
  }): Promise<Hex | null>;
  /** Reports a market's result. Returns null if a result is already recorded. */
  reportOutcome(marketId: Hex, outcome: 'yes' | 'no' | 'void'): Promise<Hex | null>;
  /** Pays a right thesis's tips to its author. Returns null if already paid. */
  settle(id: Hex): Promise<Hex | null>;
  /** Returns one tipper's tip. Returns null if they have nothing held. */
  refund(id: Hex, tipper: Address): Promise<Hex | null>;
}

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function createEscrowChain(settings: ChainSettings): EscrowChain {
  const chain = defineChain({
    id: settings.chainId,
    name: 'Arc Testnet',
    // USDC is Arc's gas token. As the native currency it has 18 decimals.
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [settings.rpcUrl] } },
  });
  const transport = http(settings.rpcUrl);
  const reader = createPublicClient({ chain, transport });
  const registrar = createWalletClient({ chain, transport, account: privateKeyToAccount(settings.registrarKey) });
  const resolver = createWalletClient({ chain, transport, account: privateKeyToAccount(settings.resolverKey) });
  const escrow = { address: settings.escrowAddress, abi: TIP_ESCROW_ABI } as const;

  async function confirmed(hash: Hex): Promise<Hex> {
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted`);
    return hash;
  }

  const api: EscrowChain = {
    escrowAddress: settings.escrowAddress,
    usdcAddress: settings.usdcAddress,

    async thesis(id) {
      const [author, marketId, contentHash, expiry, sideYes, settled, totalTips] = await reader.readContract({
        ...escrow,
        functionName: 'theses',
        args: [id],
      });
      if (author === ZERO_ADDRESS) return null;
      return { author, marketId, contentHash, expiry, sideYes, settled, totalTips };
    },

    async marketState(marketId) {
      const state = await reader.readContract({ ...escrow, functionName: 'marketState', args: [marketId] });
      return MARKET_STATES[state] ?? 'open';
    },

    tipOf: (id, tipper) => reader.readContract({ ...escrow, functionName: 'tipOf', args: [id, tipper] }),

    usdcBalance: (owner) =>
      reader.readContract({ address: settings.usdcAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }),

    usdcAllowance: (owner) =>
      reader.readContract({
        address: settings.usdcAddress,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [owner, settings.escrowAddress],
      }),

    async registerThesis(input) {
      if (await api.thesis(input.id)) return null;
      const hash = await registrar.writeContract({
        ...escrow,
        functionName: 'registerThesis',
        args: [
          input.id,
          input.author,
          input.marketId,
          input.sideYes,
          input.contentHash,
          BigInt(Math.floor(input.expiry.getTime() / 1000)),
        ],
      });
      return confirmed(hash);
    },

    async reportOutcome(marketId, outcome) {
      if ((await api.marketState(marketId)) !== 'open') return null;
      const hash =
        outcome === 'void'
          ? await resolver.writeContract({ ...escrow, functionName: 'reportVoid', args: [marketId] })
          : await resolver.writeContract({ ...escrow, functionName: 'reportOutcome', args: [marketId, outcome === 'yes'] });
      return confirmed(hash);
    },

    async settle(id) {
      const thesis = await api.thesis(id);
      if (!thesis || thesis.settled) return null;
      // Anyone may call settle. The resolver's account pays the gas.
      return confirmed(await resolver.writeContract({ ...escrow, functionName: 'settle', args: [id] }));
    },

    async refund(id, tipper) {
      if ((await api.tipOf(id, tipper)) === 0n) return null;
      return confirmed(await resolver.writeContract({ ...escrow, functionName: 'refund', args: [id, tipper] }));
    },
  };
  return api;
}
