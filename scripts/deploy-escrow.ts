/** Deploy once with a dedicated testnet key funded by the Circle TEST treasury. Journal before broadcast. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, createWalletClient, encodeDeployData, getAddress, getContractAddress, http, keccak256,
  parseEther, parseTransaction, recoverTransactionAddress, serializeTransaction, type Abi, type Hex, type TransactionSerialized } from 'viem';
import { arcTestnet, ARC_CHAIN_ID, USDC_ADDRESS, escrowAbi } from '../packages/services/src/chain/abi';
import artifact from '../packages/services/src/chain/escrow-artifact.json';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { randomUUID } from 'node:crypto';
const root = new URL('../', import.meta.url);
process.loadEnvFile(new URL('.env', root));
const journalPath = new URL('.local/escrow-deployment-v2.json', root);
let stage = 'configuration';
type Journal = { data: Hex; nonce: number; address: Hex; unsigned: Hex; signed?: Hex; hash?: Hex };
async function readJournal<T>(path: URL): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return undefined; throw new Error('journal unreadable'); }
}
async function saveSetting(key: string, value: string) {
  const path = new URL('.env', root), source = await readFile(path, 'utf8');
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  await writeFile(path, pattern.test(source) ? source.replace(pattern, `${key}=${value}`) : `${source.trimEnd()}\n${key}=${value}\n`);
}
async function main() {
  if (!process.env.CIRCLE_API_KEY?.startsWith('TEST_API_KEY:')) throw new Error('test key required');
  const circle = initiateDeveloperControlledWalletsClient({ apiKey: process.env.CIRCLE_API_KEY, entitySecret: process.env.CIRCLE_ENTITY_SECRET! });
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(arcTestnet.rpcUrls.default.http[0], { timeout: 10_000 }) });
  if (await publicClient.getChainId() !== ARC_CHAIN_ID) throw new Error('wrong chain');
  stage = 'treasury lookup';
  const wallet = (await circle.getWallet({ id: process.env.CIRCLE_TREASURY_WALLET_ID! })).data?.wallet;
  if (wallet?.blockchain !== 'ARC-TESTNET' || wallet.accountType !== 'EOA') throw new Error('test treasury EOA required');
  const authority = getAddress(wallet.address);
  if (!process.env.ARC_DEPLOYER_KEY) {
    process.env.ARC_DEPLOYER_KEY = generatePrivateKey();
    await saveSetting('ARC_DEPLOYER_KEY', process.env.ARC_DEPLOYER_KEY);
  }
  const signer = privateKeyToAccount(process.env.ARC_DEPLOYER_KEY as Hex);
  const account = signer.address;
  if (process.env.ESCROW_ADDRESS) {
    const existing = getAddress(process.env.ESCROW_ADDRESS);
    const code = await publicClient.getCode({ address: existing });
    if (!code || keccak256(code).toLowerCase() !== process.env.ESCROW_CODE_HASH?.toLowerCase()) throw new Error('existing deployment mismatch');
    console.log(JSON.stringify({ reused: true, escrowAddress: existing, chainId: ARC_CHAIN_ID })); return;
  }
  await mkdir(new URL('.local/', root), { recursive: true });
  let journal = await readJournal<Journal>(journalPath);
  if (!journal?.signed && await publicClient.getBalance({ address: account }) < parseEther('0.1')) {
    stage = 'test deployer funding';
    const fundingPath = new URL('.local/escrow-deployer-funding.json', root);
    let funding = await readJournal<{ idempotencyKey: string; circleTxId?: string }>(fundingPath);
    if (!funding) { funding = { idempotencyKey: randomUUID() }; await writeFile(fundingPath, JSON.stringify(funding)); }
    if (!funding.circleTxId) {
      const balances = (await circle.getWalletTokenBalance({ id: wallet.id })).data?.tokenBalances ?? [];
      const tokenId = balances.find(balance => balance.token.decimals === 6 && balance.token.tokenAddress?.toLowerCase() === USDC_ADDRESS)?.token.id;
      if (!tokenId) throw new Error('USDC token unavailable');
      funding.circleTxId = (await circle.createTransaction({ walletId: wallet.id, tokenId, destinationAddress: account,
        amount: ['0.25'], idempotencyKey: funding.idempotencyKey, fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        refId: 'escrow-test-deployer-gas' })).data?.id;
      await writeFile(fundingPath, JSON.stringify(funding));
    }
    const deadline = Date.now() + 60_000;
    while (await publicClient.getBalance({ address: account }) < parseEther('0.1')) {
      if (Date.now() > deadline) throw new Error('deployer funding pending');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  const data = encodeDeployData({ abi: artifact.abi as Abi, bytecode: artifact.bytecode as Hex, args: [USDC_ADDRESS, authority, authority] });
  if (!journal) {
    stage = 'fee and nonce preparation';
    const walletClient = createWalletClient({ account: signer, chain: arcTestnet, transport: http() });
    const request = await walletClient.prepareTransactionRequest({ account, data });
    if (!request.gas || !request.maxFeePerGas || request.nonce === undefined || !request.maxPriorityFeePerGas) throw new Error('gas estimate unavailable');
    if (request.gas * request.maxFeePerGas > parseEther('1')) throw new Error('deployment fee exceeds one test USDC');
    const unsigned = serializeTransaction({ type: 'eip1559', chainId: ARC_CHAIN_ID, nonce: request.nonce,
      gas: request.gas, maxFeePerGas: request.maxFeePerGas, maxPriorityFeePerGas: request.maxPriorityFeePerGas, data });
    journal = { data, nonce: request.nonce, address: getContractAddress({ from: account, nonce: BigInt(request.nonce) }), unsigned };
    await mkdir(new URL('.local/', root), { recursive: true });
    await writeFile(journalPath, JSON.stringify(journal));
  }
  if (journal.data !== data) throw new Error('pending deployment source changed');
  if (!journal.signed) {
    stage = 'test deployer signing';
    const unsigned = parseTransaction(journal.unsigned as TransactionSerialized);
    const signed = await signer.signTransaction({ type: 'eip1559', chainId: ARC_CHAIN_ID, nonce: journal.nonce,
      gas: unsigned.gas, maxFeePerGas: unsigned.maxFeePerGas, maxPriorityFeePerGas: unsigned.maxPriorityFeePerGas, data });
    if (!signed) throw new Error('signing unavailable');
    const decoded = parseTransaction(signed as TransactionSerialized);
    if (decoded.chainId !== ARC_CHAIN_ID || decoded.nonce !== journal.nonce || decoded.data !== data || decoded.to ||
      (await recoverTransactionAddress({ serializedTransaction: signed as TransactionSerialized })).toLowerCase() !== account.toLowerCase()) throw new Error('signed deployment mismatch');
    journal.signed = signed; journal.hash = keccak256(signed);
    await writeFile(journalPath, JSON.stringify(journal));
  }
  stage = 'broadcast and receipt';
  try { await publicClient.sendRawTransaction({ serializedTransaction: journal.signed }); }
  catch (error) {
    const known = await publicClient.getTransaction({ hash: journal.hash! }).catch(() => null);
    if (!known) throw error;
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash: journal.hash!, timeout: 120_000 });
  if (receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== journal.address.toLowerCase()) throw new Error('deployment failed');
  const code = await publicClient.getCode({ address: journal.address });
  if (!code) throw new Error('deployment code missing');
  const [registrar, resolver, token] = await Promise.all([
    publicClient.readContract({ address: journal.address, abi: escrowAbi, functionName: 'registrar' }),
    publicClient.readContract({ address: journal.address, abi: escrowAbi, functionName: 'resolver' }),
    publicClient.readContract({ address: journal.address, abi: escrowAbi, functionName: 'usdc' }),
  ]);
  if (registrar.toLowerCase() !== authority.toLowerCase() || resolver.toLowerCase() !== authority.toLowerCase() || token.toLowerCase() !== USDC_ADDRESS) throw new Error('deployment roles mismatch');
  await saveSetting('ARC_RPC_URL', arcTestnet.rpcUrls.default.http[0]); await saveSetting('ARC_CHAIN_ID', String(ARC_CHAIN_ID));
  await saveSetting('USDC_ADDRESS', USDC_ADDRESS); await saveSetting('ESCROW_ADDRESS', journal.address);
  await saveSetting('ESCROW_CODE_HASH', keccak256(code));
  const deployment = { chainId: ARC_CHAIN_ID, address: journal.address, transactionHash: journal.hash,
    registrar: authority, resolver: authority, deployer: account, usdc: USDC_ADDRESS, codeHash: keccak256(code),
    compiler: '0.8.28', optimizerRuns: 200, blockNumber: receipt.blockNumber.toString(), deployedAt: new Date().toISOString() };
  await mkdir(new URL('contracts/deployments/', root), { recursive: true });
  await writeFile(new URL('contracts/deployments/arc-testnet.json', root), JSON.stringify(deployment, null, 2) + '\n');
  console.log(JSON.stringify(deployment));
}
main().catch((error: unknown) => {
  const e = error as { name?: string; message?: string; response?: { status?: number; data?: { code?: number } } };
  const safeMessages = ['test key required', 'wrong chain', 'test treasury EOA required', 'existing deployment mismatch',
    'gas estimate unavailable', 'deployment fee exceeds one test USDC', 'pending deployment source changed',
    'signing unavailable', 'signed deployment mismatch', 'deployment failed', 'deployment code missing', 'deployment roles mismatch'];
  let diagnostic = e.message ?? '';
  for (const secret of [process.env.CIRCLE_API_KEY, process.env.CIRCLE_ENTITY_SECRET, process.env.ARC_DEPLOYER_KEY]) if (secret) diagnostic = diagnostic.replaceAll(secret, '[redacted]');
  diagnostic = diagnostic.replace(/TEST_API_KEY:[A-Za-z0-9:._-]+/g, '[redacted]').replace(/0x[a-f0-9]{128,}/gi, '[transaction data]');
  console.error(JSON.stringify({ stage, error: safeMessages.includes(e.message ?? '') ? e.message : diagnostic.slice(0, 180),
    errorType: e.name, httpStatus: e.response?.status, circleCode: e.response?.data?.code }));
  console.error('Preserve .local/escrow-deployment-v2.json before retrying. No credentials printed.'); process.exitCode = 1;
});
