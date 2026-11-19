import { decodeFunctionData, erc20Abi, parseEventLogs, type Hex, type Log } from 'viem';
import { escrowAbi, USDC_ADDRESS, usdcUnits } from './abi';
import type { ChainAction } from './gateway';
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** A successful bundler transaction alone does not prove the requested smart-account call succeeded. */
export function provesAction(action: ChainAction, raw: unknown[], sender: string): boolean {
  try {
    const logs = (raw as Log[]).filter(log => same(log.address, action.contractAddress));
    if (action.kind === 'fund') return parseEventLogs({ abi: erc20Abi, logs, eventName: 'Transfer' }).some(log => same(log.address, USDC_ADDRESS) && same(log.args.from, sender) && same(log.args.to, action.destination ?? '') && log.args.value === usdcUnits(action.amountUsdc!));
    if (action.kind === 'approve') {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: action.callData as Hex });
      if (decoded.functionName !== 'approve') return false;
      return parseEventLogs({ abi: erc20Abi, logs, eventName: 'Approval' }).some(log => same(log.address, USDC_ADDRESS) && same(log.args.owner, sender) && same(log.args.spender, decoded.args[0]) && log.args.value === decoded.args[1]);
    }
    const decoded = decodeFunctionData({ abi: escrowAbi, data: action.callData as Hex });
    if (action.kind === 'register' && decoded.functionName === 'registerThesis') {
      const [id, author, marketId, sideYes, contentHash, expiry] = decoded.args;
      return parseEventLogs({ abi: escrowAbi, logs, eventName: 'ThesisRegistered' }).some(log => same(log.args.id, id) && same(log.args.author, author) && same(log.args.marketId, marketId) && log.args.sideYes === sideYes && same(log.args.contentHash, contentHash) && log.args.expiry === expiry);
    }
    if (action.kind === 'tip' && decoded.functionName === 'tip') {
      const [id, amount, requestId] = decoded.args;
      return parseEventLogs({ abi: escrowAbi, logs, eventName: 'Tipped' }).some(log => same(log.args.id, id) && same(log.args.tipper, sender) && log.args.amount === amount && same(log.args.requestId, requestId));
    }
    if (action.kind === 'outcome' && (decoded.functionName === 'reportOutcome' || decoded.functionName === 'reportVoid')) {
      const expected = decoded.functionName === 'reportVoid' ? 3 : decoded.args[1] ? 1 : 2;
      return parseEventLogs({ abi: escrowAbi, logs, eventName: 'OutcomeReported' }).some(log => same(log.args.marketId, decoded.args[0]) && Number(log.args.state) === expected);
    }
    if (action.kind === 'settle' && decoded.functionName === 'settle') return parseEventLogs({ abi: escrowAbi, logs, eventName: 'AuthorPaid' }).some(log => same(log.args.id, decoded.args[0]));
    if (action.kind === 'refund' && decoded.functionName === 'refund') return parseEventLogs({ abi: escrowAbi, logs, eventName: 'Refunded' }).some(log => same(log.args.id, decoded.args[0]) && same(log.args.tipper, decoded.args[1]));
    return false;
  } catch { return false; }
}
