import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,it,expect} from 'vitest';
const context:Record<string,any>={};runInNewContext(readFileSync(new URL('../match.js',import.meta.url),'utf8'),context);
const match=context.TMMatch;
describe('extension post matching',()=>{
  it('matches case, cashtags, plurals and complete keyword groups',()=>{
    expect(match.scoreMarket('BITCOIN and $BTC',[['bitcoin']])).toBe(1);
    expect(match.scoreMarket('Fed rates remain unchanged',[['fed','rate']])).toBe(2);
    expect(match.scoreMarket('Powell considers a cut',[['powell','cut']])).toBe(2);
    expect(match.scoreMarket('FOMC meets tomorrow',[['fomc']])).toBe(1);
    expect(match.scoreMarket('Only $BTC right now',[['$btc']])).toBe(1);
    expect(match.scoreMarket('A+B is literal',[['a+b']])).toBe(1);
    expect(match.scoreMarket('aaab is unrelated',[['a+b']])).toBe(0);
  });
  it('rejects unrelated posts and substring false positives',()=>{
    expect(match.scoreMarket('A beautiful day outside',[['btc']])).toBe(0);
    expect(match.scoreMarket('Ethernet and weather',[['ether']])).toBe(0);
    expect(match.scoreMarket('FedEx delivery rates',[['fed','rate']])).toBe(0);
    expect(match.scoreMarket('Powell speaks',[['powell','cut']])).toBe(0);
  });
  it('chooses the most specific match deterministically',()=>{
    const general={symbol:'GENERAL',keywords:[['fed']]},specific={symbol:'SPECIFIC',keywords:[['fed','rate']]};
    expect(match.bestMatch('Fed rate decision',[general,specific]).symbol).toBe('SPECIFIC');expect(match.bestMatch('cats',[general,specific])).toBeNull();
  });
  it('prefers the first-mentioned market on equally specific matches',()=>{
    const btc={symbol:'BTC',keywords:[['bitcoin'],['btc']]},eth={symbol:'ETH',keywords:[['ethereum']]};
    expect(match.bestMatch('Ethereum and the ETH/BTC ratio',[btc,eth]).symbol).toBe('ETH');
    expect(match.bestMatch('Bitcoin and Ethereum',[eth,btc]).symbol).toBe('BTC');
  });
});
