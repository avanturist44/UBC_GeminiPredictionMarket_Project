/** Read-only verification of live copies against official Gemini outcomes and Arc receipt logs. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, http, parseEventLogs, type Hex } from 'viem';
import { createDb, eq, theses, markets, tips, walletAccounts, thesisRegistrations } from '../packages/db/src/index';
import { createGeminiPublicClient } from '../packages/core/src/index';
import { hashContent } from '../packages/services/src/index';
import { arcTestnet, escrowAbi } from '../packages/services/src/chain/abi';
process.loadEnvFile(new URL('../.env', import.meta.url));
assert(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname));
const state = JSON.parse(await readFile(new URL('../.local/phase4-live.json', import.meta.url), 'utf8'));
const connection = createDb(process.env.DATABASE_URL!, { max: 1 });
const rpc = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
const gemini = createGeminiPublicClient({ logger: { warn() {} } });
const address = process.env.ESCROW_ADDRESS as Hex;
const cases: unknown[] = [];
try {
  assert.equal(await rpc.getChainId(), 5042002);
  for (const attempt of state.attempts) for (const side of ['yes', 'no']) {
    const [row] = await connection.db.select({ thesis: theses, market: markets, tip: tips, wallet: walletAccounts, registration: thesisRegistrations })
      .from(tips).innerJoin(theses, eq(theses.id, tips.thesisId)).innerJoin(markets, eq(markets.id, theses.marketId))
      .innerJoin(walletAccounts, eq(walletAccounts.userId, tips.userId))
      .innerJoin(thesisRegistrations, eq(thesisRegistrations.thesisId, theses.id)).where(eq(tips.id, attempt.copyIds[side]));
    if (!row || !['paid', 'refunded'].includes(row.tip.status)) continue;
    assert(row.tip.depositTx && row.tip.settleTx && row.wallet.address);
    const official = await gemini.getEvent(row.market.eventTicker);
    const contract = official?.contracts.find(c => c.instrumentSymbol === row.market.instrumentSymbol);
    assert(contract && (contract.resolutionSide === 'yes' || contract.resolutionSide === 'no'));
    const won = contract.resolutionSide === row.thesis.side;
    assert.equal(row.tip.status, won ? 'paid' : 'refunded');
    const onchain = await rpc.readContract({ address, abi: escrowAbi, functionName: 'theses', args: [row.thesis.onchainId as Hex] });
    const outcome = await rpc.readContract({ address, abi: escrowAbi, functionName: 'marketState', args: [row.registration.marketHash as Hex] });
    assert.equal(outcome, contract.resolutionSide === 'yes' ? 1 : 2);
    assert.equal(onchain[6], 0n);
    const deposit = await rpc.getTransactionReceipt({ hash: row.tip.depositTx as Hex });
    const payout = await rpc.getTransactionReceipt({ hash: row.tip.settleTx as Hex });
    assert.equal(deposit.status, 'success'); assert.equal(payout.status, 'success');
    const deposited = parseEventLogs({ abi: escrowAbi, eventName: 'Tipped', logs: deposit.logs.filter(l => l.address.toLowerCase() === address.toLowerCase()) });
    assert(deposited.some(l => l.args.id === row.thesis.onchainId && l.args.tipper.toLowerCase() === row.wallet.address!.toLowerCase() && l.args.amount === 100_000n && l.args.requestId === hashContent(row.tip.id)));
    const payments = parseEventLogs({ abi: escrowAbi, logs: payout.logs.filter(l => l.address.toLowerCase() === address.toLowerCase()) });
    assert(payments.some(l => l.eventName === (won ? 'AuthorPaid' : 'Refunded') && l.args.id === row.thesis.onchainId && l.args.amount === 100_000n &&
      ('author' in l.args ? l.args.author.toLowerCase() === row.registration.authorAddress.toLowerCase() : 'tipper' in l.args && l.args.tipper.toLowerCase() === row.wallet.address!.toLowerCase())));
    cases.push({ thesisId: row.thesis.id, market: row.market.instrumentSymbol, side, officialOutcome: contract.resolutionSide,
      amountUsdc: row.tip.amountUsdc, status: row.tip.status, depositTx: row.tip.depositTx, settleTx: row.tip.settleTx, remainingThesisPool: '0', receiptProof: true });
  }
  assert(cases.length, 'No completed live receipt proofs yet');
  const evidence = { checkedAt: new Date().toISOString(), contract: address, chainId: 5042002, cases };
  await writeFile(new URL('../.local/phase4-receipts.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await connection.close(); }
