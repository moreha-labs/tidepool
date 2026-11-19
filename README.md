# Tidepool: $tAMM exchange on GIWA Sepolia

A small exchange for **$tAMM**, built with the official
[`@ammora-protocol/sdk@0.3.9`](https://www.npmjs.com/package/@ammora-protocol/sdk).

**Testnet only** (GIWA Sepolia, chain 91342). No real funds, no backend, no keys. Everything runs in the
browser, and every transaction is signed in your own wallet.

Independent builder project for the Ammora Season 2 builder mission. Not run by Ammora.

## What it does

- **Swap ETH ↔ $tAMM** with live quotes from the graduated $tAMM pool.
- **SDK calldata**: buys use `buildV3NativePoolExactInput`, and sells use `buildV3PoolExactInputForNative`.
  Both go through the Ammora native router.
- **Safety first**:
  - checks on-chain that the token really is $tAMM (symbol and decimals from the SDK constants);
  - takes a fresh quote right before sending, with a 1% minimum-received floor and a 10-minute deadline;
  - approves only the exact $tAMM amount being sold;
  - dry-runs every swap with `eth_call` before the wallet is asked to sign;
  - treats a reverted receipt as a failure, never as a success.
- Market panel (pool status, price, latest block) and wallet balances refresh every 30 seconds.

## Addresses (GIWA Sepolia)

| | Address |
| --- | --- |
| $tAMM token | `0x10B3Cc2fc981277Ada576891CF649D0ABA768B06` |
| $tAMM launch curve | `0x1FD82a1BeAff168BdeFC790EB0f1A50f7C53b978` |
| Ammora native router | `0x4FC91b90087288520A7bB4aA7Ab5441bb4E9C496` |
| WETH | `0x4200000000000000000000000000000000000006` (`TAMM_GIWA_SEPOLIA_WETH` in the SDK) |

The pool address is not hard-coded. It is read live from the curve's `canonicalPool()`.

## Run locally

```bash
cd source
npm install
npm run dev
```

`npm run build` produces one self-contained `dist/index.html`. That file is the `index.html` at the root of
this repository, served by GitHub Pages.

Get free test ETH at https://faucet.giwa.io/.

## License

MIT
