import { describe, expect, it } from 'vitest';
import { ARC_PUBLIC_RPC_URLS, arcRpcUrls, redactRpcUrls } from '../src/escrow-abi';

const QUICKNODE = 'https://red-cat.arc-testnet.quiknode.pro/0123456789abcdef/';

describe('arcRpcUrls', () => {
  it('puts the configured endpoint first and Arc’s public nodes after it', () => {
    expect(arcRpcUrls(QUICKNODE)).toEqual([QUICKNODE, ...ARC_PUBLIC_RPC_URLS]);
  });

  it('falls back to the public nodes alone when nothing is configured', () => {
    expect(arcRpcUrls(undefined)).toEqual([...ARC_PUBLIC_RPC_URLS]);
    expect(arcRpcUrls('  ')).toEqual([...ARC_PUBLIC_RPC_URLS]);
  });

  it('does not list a public node twice when it is the one configured', () => {
    expect(arcRpcUrls('https://rpc.testnet.arc.io/')).toEqual(['https://rpc.testnet.arc.io/', 'https://rpc.testnet.arc.network']);
  });
});

describe('redactRpcUrls', () => {
  it('hides the token in an endpoint’s path, with or without the trailing slash', () => {
    const message = `HTTP request failed.\nURL: ${QUICKNODE}\nalso https://red-cat.arc-testnet.quiknode.pro/0123456789abcdef`;
    const out = redactRpcUrls(message, arcRpcUrls(QUICKNODE));
    expect(out).not.toContain('0123456789abcdef');
    expect(out).toContain('https://red-cat.arc-testnet.quiknode.pro/[hidden]');
  });

  it('leaves public nodes, which carry no token, readable', () => {
    expect(redactRpcUrls('URL: https://rpc.testnet.arc.io', arcRpcUrls(QUICKNODE))).toBe('URL: https://rpc.testnet.arc.io');
  });
});
