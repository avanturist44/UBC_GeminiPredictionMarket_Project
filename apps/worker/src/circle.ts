import { HttpResponseError, initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

/**
 * Circle developer-controlled wallets on Arc testnet: one smart contract account per user,
 * so a user never sees a seed phrase. These wallets are custodial: the server can move the
 * test USDC in them. That is a stated trust assumption of this build.
 *
 * Only the worker talks to Circle. The entity secret never reaches the web app or a browser.
 */

export const ARC_TESTNET = 'ARC-TESTNET';

export interface CircleSettings {
  apiKey: string;
  entitySecret: string;
  walletSetId: string;
  treasuryWalletId: string;
  usdcAddress: string;
}

export type CircleTxState = 'pending' | 'complete' | 'failed';

export interface CircleTx {
  state: CircleTxState;
  /** The on-chain transaction, once Circle has broadcast it. */
  txHash: string | null;
  /** Circle's reason when it failed. */
  error: string | null;
}

export interface CircleWallets {
  /** Creates a smart contract account for a user. `refId` ties it to the user's id. */
  createWallet(refId: string): Promise<{ walletId: string; address: string }>;
  /** Sends test USDC from the treasury. Returns Circle's transaction id. */
  fundFromTreasury(address: string, amountUsdc: string, idempotencyKey: string): Promise<string>;
  /** Calls a contract from a user's wallet. Returns Circle's transaction id. */
  execute(input: {
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: string[];
    idempotencyKey: string;
  }): Promise<string>;
  transaction(id: string): Promise<CircleTx>;
}

const FEE = { type: 'level', config: { feeLevel: 'MEDIUM' } } as const;
const FAILED = new Set(['FAILED', 'DENIED', 'CANCELLED', 'STUCK']);
const DONE = new Set(['COMPLETE', 'CONFIRMED']);

/**
 * Circle answered and said no: the request itself is wrong (for example the call would
 * revert, or the wallet cannot pay), so sending it again will not help.
 *
 * Anything else that goes wrong (a timeout, a dropped connection, a rate limit, a 5xx) is
 * a moment's trouble and is thrown as it came, so the caller tries again later.
 */
export class CircleRefused extends Error {
  override name = 'CircleRefused';
}

/** 4xx statuses that mean "not now" rather than "no". */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429]);
/**
 * Circle's codes for a request key it has already seen (wallets API, contracts API).
 * The first request got through, so this is not a refusal: the caller must not give up on it.
 */
const KEY_ALREADY_USED = new Set([156020, 175403]);

/** Turns Circle's own refusals into `CircleRefused`; passes every other error through. */
export function classifyCircleError(error: unknown): unknown {
  if (!(error instanceof HttpResponseError)) return error;
  const { status, code } = error;
  if (status < 400 || status >= 500 || RETRYABLE_STATUS.has(status) || KEY_ALREADY_USED.has(code)) return error;
  return new CircleRefused(`Circle refused the request (${code}): ${error.message}`);
}

const call = async <T>(request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error) {
    throw classifyCircleError(error);
  }
};

export function createCircleWallets(settings: CircleSettings): CircleWallets {
  const sdk = initiateDeveloperControlledWalletsClient({
    apiKey: settings.apiKey,
    entitySecret: settings.entitySecret,
  });
  // Every Circle call goes through `call`, so a refusal is always told apart from an outage.
  const client = {
    getWalletTokenBalance: (input: Parameters<typeof sdk.getWalletTokenBalance>[0]) => call(() => sdk.getWalletTokenBalance(input)),
    createWallets: (input: Parameters<typeof sdk.createWallets>[0]) => call(() => sdk.createWallets(input)),
    createTransaction: (input: Parameters<typeof sdk.createTransaction>[0]) => call(() => sdk.createTransaction(input)),
    createContractExecutionTransaction: (input: Parameters<typeof sdk.createContractExecutionTransaction>[0]) =>
      call(() => sdk.createContractExecutionTransaction(input)),
    getTransaction: (input: Parameters<typeof sdk.getTransaction>[0]) => call(() => sdk.getTransaction(input)),
  };
  let usdcTokenId: string | undefined;

  /** Circle names tokens by its own id. The treasury's balance list has USDC's. */
  async function treasuryUsdcTokenId(): Promise<string> {
    if (usdcTokenId) return usdcTokenId;
    const balances = (await client.getWalletTokenBalance({ id: settings.treasuryWalletId })).data?.tokenBalances ?? [];
    const usdc = balances.find((b) => b.token?.tokenAddress?.toLowerCase() === settings.usdcAddress.toLowerCase());
    if (!usdc?.token?.id) throw new Error('The treasury wallet holds no USDC');
    usdcTokenId = usdc.token.id;
    return usdcTokenId;
  }

  return {
    async createWallet(refId) {
      const response = await client.createWallets({
        walletSetId: settings.walletSetId,
        blockchains: [ARC_TESTNET],
        count: 1,
        accountType: 'SCA',
        metadata: [{ name: `user ${refId.slice(0, 8)}`, refId }],
      });
      const wallet = response.data?.wallets?.[0];
      if (!wallet?.id || !wallet.address) throw new Error('Circle returned no wallet');
      return { walletId: wallet.id, address: wallet.address };
    },

    async fundFromTreasury(address, amountUsdc, idempotencyKey) {
      const response = await client.createTransaction({
        walletId: settings.treasuryWalletId,
        tokenId: await treasuryUsdcTokenId(),
        destinationAddress: address,
        amount: [amountUsdc],
        fee: FEE,
        idempotencyKey,
      });
      const id = response.data?.id;
      if (!id) throw new Error('Circle did not accept the funding transfer');
      return id;
    },

    async execute(input) {
      const response = await client.createContractExecutionTransaction({
        walletId: input.walletId,
        contractAddress: input.contractAddress,
        abiFunctionSignature: input.abiFunctionSignature,
        abiParameters: input.abiParameters,
        fee: FEE,
        idempotencyKey: input.idempotencyKey,
      });
      const id = response.data?.id;
      if (!id) throw new Error('Circle did not accept the contract call');
      return id;
    },

    async transaction(id) {
      const tx = (await client.getTransaction({ id })).data?.transaction;
      const state = tx?.state ?? 'INITIATED';
      return {
        state: DONE.has(state) ? 'complete' : FAILED.has(state) ? 'failed' : 'pending',
        txHash: tx?.txHash ?? null,
        error: FAILED.has(state) ? (tx?.errorReason ?? tx?.errorDetails ?? state) : null,
      };
    },
  };
}
