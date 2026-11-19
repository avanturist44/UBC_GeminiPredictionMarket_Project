# TipEscrow

Holds each tip until the market resolves, then pays the author if the thesis was right or
returns the tip if it was wrong. Funds have two exits only: the author address fixed at
registration, or back to the tipper. There is no owner withdrawal, no fee and no upgrade path.

The contract and its tests are the reference implementation from the build plan, unchanged.

## Test

Needs [Foundry](https://getfoundry.sh): `curl -L https://foundry.paradigm.xyz | bash`, then `foundryup`.

```bash
cd contracts
forge install --no-git foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge test -vv
```

`lib/` is not committed; the install command above recreates it.

## Deploy to Arc testnet

Chain ID 5042002, RPC `https://rpc.testnet.arc.io`, USDC at
`0x3600000000000000000000000000000000000000` (6 decimals; it is also the gas token).
The deployer, registrar and resolver accounts each need a little test USDC for gas.

```bash
forge create src/TipEscrow.sol:TipEscrow \
  --rpc-url $ARC_RPC_URL --private-key $DEPLOYER_KEY --broadcast \
  --constructor-args $USDC_ADDRESS $REGISTRAR_ADDRESS $RESOLVER_ADDRESS
```

Then put the address in `ESCROW_ADDRESS`.

### Deployed

| | |
| --- | --- |
| Contract | [`0xd87dcE5Ad5b427aC210ABB77F0F1007d419CBe09`](https://explorer.testnet.arc.io/address/0xd87dcE5Ad5b427aC210ABB77F0F1007d419CBe09), source verified |
| Deployment | [`0xb164aebed52d336b1d83a144cca0c406403c9a4c596878b34fe594b05e0554c2`](https://explorer.testnet.arc.io/tx/0xb164aebed52d336b1d83a144cca0c406403c9a4c596878b34fe594b05e0554c2), 2026-11-18 |
| Registrar | `0x034aE8a173dFaC9A7558d767f5B2F4898ef0B9CF` |
| Resolver | `0x33C43C81475C8773BC89163725408b4107558805` |
| Tests | 8 passed, including a fuzz test of 512 runs (`forge test`, Solidity 0.8.28) |

A full lifecycle run on the deployed contract (`pnpm --filter @thesis/worker verify:escrow`):
[register](https://explorer.testnet.arc.io/tx/0xa3e171123270b3ebf5f8e3839917a9d4bbd34615a8726857f2f561ed1d0d503f),
[tip](https://explorer.testnet.arc.io/tx/0xed82840b5a03be86e29e37302e40a08fcec4ab17fa7307555e51563c7f3f156a),
[outcome reported](https://explorer.testnet.arc.io/tx/0x101ded44db555864e930d6538da5648cfc82d00df3754261fff238c98158fec0),
[author paid](https://explorer.testnet.arc.io/tx/0xca38d1afe7b0775a154fb480afc93043e8c98de9fbe4a85f06c1d3f983c72c42). The interface the app uses is written out in
`packages/core/src/escrow-abi.ts`; `forge inspect TipEscrow abi` prints the authoritative one.

## Trust assumptions

- The resolver key is trusted to report Gemini's result honestly. A false report can misdirect
  at most the tips on that market, never more than 5 USDC per tipper per thesis.
- The registrar key is trusted to record the correct author address and side.
- If a market has no reported outcome 7 days after a thesis expires, anyone can refund its tips.
- User wallets are custodial in this build: they are Circle developer-controlled wallets, so the server can move a user's test USDC.
- A production version would replace the resolver with a result that Gemini signs or that several independent reporters agree on, and would use wallets the user controls.
