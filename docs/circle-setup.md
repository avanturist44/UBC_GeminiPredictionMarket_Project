# Circle testnet onboarding

Generating a 32-byte entity secret is separate from registering it with Circle. If an existing Circle wallet is already configured, use that account's existing registered secret and recovery procedure rather than replacing it.

For a new test account, put a fresh test API key in the ignored `C:/UBC_Hack/.env` as `CIRCLE_API_KEY`. The registration helper generates its own new secret without printing it. Do not copy a secret that has appeared in chat or terminal output into this setup.

Run from PowerShell:

```powershell
cd C:\UBC_Hack
node scripts/register-circle-entity.mjs --register
```

The helper saves the generated secret in the ignored root `.env` before calling Circle, registers it, and saves the returned recovery file under ignored `.local/circle-recovery/`. Back up that recovery file separately in secure storage. It refuses existing entity secrets, existing wallet IDs and repeat/concurrent registration attempts. If a request fails, preserve the saved secret and check Circle Console before retrying: registration is not idempotent.

After registration, create or locate the wallet set and treasury using the existing Circle setup tooling. Record their IDs locally. Confirm that the wallet receiving faucet tokens is controlled by the intended treasury before treating those funds as available to the app.

## Completed local setup

Circle test-account entity-secret registration completed on November 18, 2026 (Pacific). The secret and API key remain in the ignored root `.env`; recovery files are stored under ignored `.local/circle-recovery/`. The SDK's extra recovery artifact was moved out of the repository root, and the helper now explicitly directs SDK recovery output into that ignored directory. Recovery files also have a defensive Git ignore rule.

The wallet setup command created and saved these public IDs:

- Wallet set: `86a7ae51-a766-575c-9999-833331a0910a`
- Treasury wallet: `f81a6861-8125-5486-a31a-13d4a8115a03`
- Treasury address on Arc testnet: `0x0c6685d5957e93099d5844f9b111df09ce61ef37`

An independent Arc RPC check confirmed the supplied faucet transaction succeeded and transferred 100 test USDC to `0x0dde1dd31fd190a4bd39807ac09a5f93bfbff1be`. That destination is different from the newly created Circle treasury. The app treasury balance was zero when checked; it still needs testnet funding. No escrow deployment or token transfer was initiated by this setup.

After the subsequent faucet request, a fresh public Arc RPC balance check confirmed **100 testnet USDC** at the configured Circle treasury, `0x0c6685d5957e93099d5844f9b111df09ce61ef37`. This supersedes the earlier zero-balance checkpoint. The Circle account, registered entity secret, saved wallet IDs and treasury funding are now ready for the Phase 4 escrow integration. No escrow has been deployed yet.

Phase 4 subsequently deployed the escrow, created guest SCA wallets and connected managed USDC transfers and contract execution. The treasury is now being used for bounded testnet funding and network fees; its initial 100-USDC balance is a historical funding checkpoint. See [the escrow and copy-trading handoff](phase-4-escrow-copy-trading.md) for the deployed contract and verification evidence. No mainnet funds are configured.

The setup script persists each new public ID immediately, so a later partial failure can resume without creating another wallet set. Registration remains a one-time operation and must not be repeated blindly. Back up the recovery file separately in secure storage.

Source: [Circle's entity-secret registration guide](https://developers.circle.com/wallets/dev-controlled/register-entity-secret).
