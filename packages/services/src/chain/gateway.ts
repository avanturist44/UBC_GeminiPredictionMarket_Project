import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, http, erc20Abi, getAddress, isAddress, keccak256, parseEventLogs, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { chainActions } from '@thesis/db';
import { PublicationError } from '../publication';
import { arcTestnet, ARC_CHAIN_ID, USDC_ADDRESS, escrowAbi } from './abi';
import { provesAction } from './receipts';

export type ChainAction = typeof chainActions.$inferSelect;
export type ChainGateway = {
  escrowAddress: Address; treasuryWalletId: string;
  assertReady(): Promise<void>;
  createWallet(ownerKey: string, idempotencyKey: string): Promise<{ id: string; address: string }>;
  submit(action: ChainAction): Promise<string>;
  inspect(id: string): Promise<{ state: 'pending' | 'failed' | 'confirmed'; hash?: string }>;
  receipt(hash: string): Promise<{ success: boolean; logs: unknown[] } | null>;
  prove(action: ChainAction, logs: unknown[]): Promise<boolean>;
  balance(address: string): Promise<bigint>;
  allowance(address: string): Promise<bigint>;
  registered(id: string): Promise<{ author: string; marketHash: string; contentHash: string; expiry: number; sideYes: boolean; settled: boolean }>;
  outcome(marketHash: string): Promise<number>;
  tipBalance(id: string, address: string): Promise<bigint>;
};
export function arcConfig(env: Record<string, string | undefined> = process.env) {
  if (env.TRADING_MODE && env.TRADING_MODE !== 'paper') throw new PublicationError('testnet_only', 503);
  if (!env.CIRCLE_API_KEY?.startsWith('TEST_API_KEY:') || !/^[a-f0-9]{64}$/i.test(env.CIRCLE_ENTITY_SECRET ?? '')) throw new PublicationError('chain_not_configured', 503);
  const uuid = z.string().uuid();
  const treasuryWalletId = uuid.parse(env.CIRCLE_TREASURY_WALLET_ID), walletSetId = uuid.parse(env.CIRCLE_WALLET_SET_ID);
  if (Number(env.ARC_CHAIN_ID ?? ARC_CHAIN_ID) !== ARC_CHAIN_ID || (env.USDC_ADDRESS && env.USDC_ADDRESS.toLowerCase() !== USDC_ADDRESS)) throw new PublicationError('testnet_only', 503);
  if (!isAddress(env.ESCROW_ADDRESS ?? '') || !/^0x[a-f0-9]{64}$/i.test(env.ESCROW_CODE_HASH ?? '')) throw new PublicationError('chain_not_configured', 503);
  const rpcUrl = env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];
  if (new URL(rpcUrl).protocol !== 'https:') throw new PublicationError('testnet_only', 503);
  return { apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET!, treasuryWalletId, walletSetId,
    rpcUrl, escrowAddress: getAddress(env.ESCROW_ADDRESS!), codeHash: env.ESCROW_CODE_HASH!.toLowerCase() };
}
export function createArcGateway(config = arcConfig()): ChainGateway {
  const client = initiateDeveloperControlledWalletsClient({ apiKey: config.apiKey, entitySecret: config.entitySecret });
  const rpc = createPublicClient({ chain: arcTestnet, transport: http(config.rpcUrl, { timeout: 10_000, retryCount: 1 }) });
  let checkedAt = 0;
  const checkedWallets = new Set<string>();
  let usdcTokenId: string | undefined;
  async function checkWallet(id: string) {
    if (checkedWallets.has(id)) return;
    const wallet = (await client.getWallet({ id })).data?.wallet;
    if (wallet?.blockchain !== 'ARC-TESTNET' || !wallet.address) throw new PublicationError('testnet_only', 503);
    checkedWallets.add(id);
  }
  const fee = { type: 'level' as const, config: { feeLevel: 'MEDIUM' as const } };
  const gateway: ChainGateway = {
    escrowAddress: config.escrowAddress, treasuryWalletId: config.treasuryWalletId,
    async assertReady() {
      if (Date.now() - checkedAt < 30_000) return;
      if (await rpc.getChainId() !== ARC_CHAIN_ID) throw new PublicationError('testnet_only', 503);
      const code = await rpc.getCode({ address: config.escrowAddress });
      if (!code || keccak256(code).toLowerCase() !== config.codeHash) throw new PublicationError('escrow_mismatch', 503);
      const treasury = (await client.getWallet({ id: config.treasuryWalletId })).data?.wallet;
      if (treasury?.blockchain !== 'ARC-TESTNET' || !treasury.address) throw new PublicationError('testnet_only', 503);
      const [token, registrar, resolver, decimals] = await Promise.all([
        rpc.readContract({ address: config.escrowAddress, abi: escrowAbi, functionName: 'usdc' }),
        rpc.readContract({ address: config.escrowAddress, abi: escrowAbi, functionName: 'registrar' }),
        rpc.readContract({ address: config.escrowAddress, abi: escrowAbi, functionName: 'resolver' }),
        rpc.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'decimals' }),
      ]);
      if (token.toLowerCase() !== USDC_ADDRESS || registrar.toLowerCase() !== treasury.address.toLowerCase() ||
        resolver.toLowerCase() !== treasury.address.toLowerCase() || decimals !== 6) throw new PublicationError('escrow_mismatch', 503);
      checkedAt = Date.now(); checkedWallets.add(config.treasuryWalletId);
    },
    async createWallet(ownerKey, idempotencyKey) {
      await gateway.assertReady();
      const result = await client.createWallets({ idempotencyKey, walletSetId: config.walletSetId,
        blockchains: ['ARC-TESTNET'], accountType: 'SCA', count: 1, metadata: [{ name: 'Thesis Market test wallet', refId: ownerKey }] });
      const wallet = result.data?.wallets?.[0];
      if (!wallet?.id || !wallet.address || wallet.blockchain !== 'ARC-TESTNET' || wallet.accountType !== 'SCA') throw new PublicationError('wallet_unavailable', 503);
      checkedWallets.add(wallet.id); return { id: wallet.id, address: getAddress(wallet.address) };
    },
    async submit(action) {
      await gateway.assertReady(); await checkWallet(action.walletId);
      if (action.kind === 'fund' && !usdcTokenId) {
        const balances = (await client.getWalletTokenBalance({ id: config.treasuryWalletId })).data?.tokenBalances ?? [];
        usdcTokenId = balances.find(balance => balance.token.blockchain === 'ARC-TESTNET' && balance.token.decimals === 6 &&
          balance.token.tokenAddress?.toLowerCase() === USDC_ADDRESS)?.token.id;
        if (!usdcTokenId) throw new PublicationError('chain_not_configured', 503);
      }
      const result = action.kind === 'fund' ? await client.createTransaction({ idempotencyKey: action.idempotencyKey,
        walletId: config.treasuryWalletId, tokenId: usdcTokenId!,
        destinationAddress: action.destination!, amount: [action.amountUsdc!], fee, refId: action.idempotencyKey })
        : await client.createContractExecutionTransaction({ idempotencyKey: action.idempotencyKey,
          walletId: action.walletId, contractAddress: action.contractAddress, callData: action.callData as Hex, fee, refId: action.idempotencyKey });
      const id = result.data?.id;
      if (!id) throw new PublicationError('chain_pending', 503);
      return id;
    },
    async inspect(id) {
      const transaction = (await client.getTransaction({ id })).data?.transaction;
      if (!transaction) return { state: 'pending' };
      if (['FAILED', 'CANCELLED', 'DENIED'].includes(transaction.state)) return { state: 'failed', hash: transaction.txHash };
      return { state: transaction.txHash ? 'confirmed' : 'pending', hash: transaction.txHash };
    },
    async receipt(hash) {
      try { const receipt = await rpc.getTransactionReceipt({ hash: hash as Hex });
        return { success: receipt.status === 'success', logs: receipt.logs }; }
      catch { return null; }
    },
    async balance(address) { await gateway.assertReady(); return rpc.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(address)] }); },
    async prove(action, logs) {
      const wallet = (await client.getWallet({ id: action.walletId })).data?.wallet;
      return !!wallet?.address && wallet.blockchain === 'ARC-TESTNET' && provesAction(action, logs, wallet.address);
    },
    async allowance(address) { await gateway.assertReady(); return rpc.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'allowance', args: [getAddress(address), config.escrowAddress] }); },
    async registered(id) {
      const [author, marketHash, contentHash, expiry, sideYes, settled] = await rpc.readContract({ address: config.escrowAddress, abi: escrowAbi, functionName: 'theses', args: [id as Hex] });
      return { author, marketHash, contentHash, expiry: Number(expiry), sideYes, settled };
    },
    async outcome(marketHash) { return rpc.readContract({ address: config.escrowAddress, abi: escrowAbi, functionName: 'marketState', args: [marketHash as Hex] }); },
    async tipBalance(id, address) { return rpc.readContract({ address: config.escrowAddress, abi: escrowAbi, functionName: 'tipOf', args: [id as Hex, getAddress(address)] }); },
  };
  return gateway;
}
