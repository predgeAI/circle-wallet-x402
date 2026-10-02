# Pay an x402 paywall from a Circle developer-controlled wallet

An agent that pays per call usually holds a private key and some native gas. With this script it
holds neither. Circle custodies the key, the agent asks Circle to sign, and the x402 paywall's
facilitator submits the payment and pays the gas. The wallet only needs USDC.

It pays any x402 v2 endpoint that offers the `exact` scheme (EIP-3009) with USDC on Base or Arc,
mainnet or testnet.

## Why it is one call

On an EVM chain, x402's `exact` scheme is an EIP-3009 `transferWithAuthorization`. That is signed
EIP-712 typed data, and Circle's developer-controlled wallets have `signTypedData`. So the
integration is not an adapter: `signTypedData` goes where an agent would otherwise use its own key.

## What has actually run

| Path | Status |
|---|---|
| Base mainnet: Circle wallet pays an x402 v2 paywall | 51 paid calls between 21:57 and 22:02 UTC on 1 October 2026, all settled on-chain, made with the script this reference was cut down from (same signing path). Payer: [`0x718bc0901be5008698df3ffdea616085c2970bd6`](https://basescan.org/address/0x718bc0901be5008698df3ffdea616085c2970bd6#tokentxns) |
| Arc mainnet: x402 v2 paywall settled by Circle's facilitator | Live. First settlement, paid from an ordinary key: [`0x38a715a7…fedd8`](https://explorer.arc.io/tx/0x38a715a7d5f07f1b587a7e8c06da3d8d787ce8beec91a84b7b7a0604fc8fedd8) |
| Arc mainnet: Circle wallet as the payer | Not run yet. The Circle SDK supports `ARC` wallets, and the offline tests check the Arc typed data against the USDC contract's on-chain domain. |
| This script against a live paywall | `pay --dry-run` on 2 October 2026 against `https://api.predge.io/v1/whales/latest?limit=1` from the Base wallet above, with a LIVE key. Circle signed the EIP-3009 authorization, the script recovered it to the wallet's address, and nothing was sent. |
| This script offline | `npm test`: 13 tests pass, with no Circle account, network or funds. |

The same Circle wallet also moved USDC from Base to Arbitrum One with CCTP V2, 20 times on 2 October 2026. All the transactions went through the Wallets API: [mints on Arbitrum One](https://arbiscan.io/address/0x718bc0901be5008698df3ffdea616085c2970bd6#tokentxns). That script is not part of this reference.

## Requirements

- Node.js 22 or newer (the Circle SDK requires it).
- A Circle developer account and an API key from console.circle.com. A TEST key works on Base
  Sepolia and Arc Testnet. Mainnet needs a LIVE key, and a LIVE key returns 403 on wallet calls
  until the Mainnet account setup in the console is complete, billing details included.
- A little USDC on the wallet's chain. No ETH and no other gas token.

## Quick start (Base)

```bash
npm install
cp .env.example .env && chmod 600 .env   # put CIRCLE_API_KEY in it
node circle-x402.mjs setup                # once: entity secret, written to .env
node circle-x402.mjs create-wallet BASE   # prints the address, writes CIRCLE_WALLET_ID
# send about 1 USDC on Base to that address
node circle-x402.mjs pay "https://api.predge.io/v1/whales/latest?limit=1" --dry-run
node circle-x402.mjs pay "https://api.predge.io/v1/whales/latest?limit=1"
```

The example URL is a live x402 v2 route that costs $0.005 and accepts USDC on Base, Arc, Solana
and Algorand. Any other x402 v2 URL works the same way. `--dry-run` does everything except send
the payment.

## On Arc

Circle signs only for the chain a wallet belongs to, so the wallet decides the network. An EVM
wallet's key can be given an Arc wallet id with the same address:

```bash
node circle-x402.mjs derive ARC                               # prints a new wallet id, same address
CIRCLE_WALLET_ID=<that id> node circle-x402.mjs pay "<url>" --dry-run
```

Fund the address with USDC on Arc, then run without `--dry-run`. The script pays the requirement
for `eip155:5042` (Arc mainnet) or `eip155:5042002` (Arc Testnet) and ignores the others.

Not run yet with a real Circle wallet on Arc: `derive` uses the SDK's `deriveWallet`, which lists
`ARC` and `ARC-TESTNET`, and the Arc typed data is covered by the offline tests, but nobody has
paid from an Arc Circle wallet with this script so far. Try `--dry-run` on Arc Testnet first.

## What `pay` does

1. Requests the resource and reads the terms from the 402's `PAYMENT-REQUIRED` header.
2. Picks the `exact` requirement on the wallet's chain. It refuses if the price is above
   `X402_MAX_AMOUNT`, if the payee is not `X402_EXPECT_PAY_TO` (when set), if the server wants
   Permit2 instead of EIP-3009, or if the 402 does not name the token's EIP-712 domain.
3. Builds the EIP-3009 authorization from the server's terms: amount, payee, a settlement window
   of `maxTimeoutSeconds`, a random nonce, and the token domain from the requirement's `extra`.
4. Asks Circle to sign it.
5. Recovers the signer locally and sends nothing unless it is the wallet's own address.
6. Repeats the request with `PAYMENT-SIGNATURE`, then prints the HTTP status, the settlement
   transaction from `PAYMENT-RESPONSE` with an explorer link, and the start of the response body.

## Configuration

All settings come from the environment or from `.env` next to the script. Values already in the
environment win. See `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `CIRCLE_API_KEY` | | Circle API key, TEST or LIVE |
| `CIRCLE_ENTITY_SECRET` | | Written by `setup` |
| `CIRCLE_WALLET_ID` | | Written by `create-wallet`; `derive` prints one per extra chain |
| `CIRCLE_BLOCKCHAIN` | `BASE` | Chain for `create-wallet`: `BASE`, `BASE-SEPOLIA`, `ARC`, `ARC-TESTNET` |
| `CIRCLE_RECOVERY_DIR` | `.circle-recovery/` | Where `setup` saves Circle's recovery file |
| `X402_URL` | | Resource to pay for, if not given on the command line |
| `X402_METHOD`, `X402_BODY`, `X402_CONTENT_TYPE` | `GET`, none, `application/json` | For paid POST routes |
| `X402_MAX_AMOUNT` | `10000` | Price cap per call in atomic units (USDC has 6 decimals, so 0.01 USDC) |
| `X402_EXPECT_PAY_TO` | | Refuse any other payee |
| `X402_PAY_NETWORK` | the wallet's chain | CAIP-2 network to pay on; must match the wallet |

Adding another EVM chain where Circle has wallets and USDC supports EIP-3009 is one line in
`CIRCLE_CHAINS` in `lib/x402.mjs`.

## Things Circle enforces that EIP-712 does not

1. `types` must include `EIP712Domain`. Most signers infer it, and some reject it when present.
   Circle is the other way round and fails with "there is extra data provided in the message" when
   it is missing. Including it does not change the digest; a test checks that.
2. `domain.chainId` must be the chain the wallet was created on. A Base Sepolia wallet asked to
   sign a Base mainnet authorization fails with a misleading "invalid transaction or
   rawTransaction in request". A sandbox key can prove the signing, but it cannot pay mainnet.
3. EOA wallets only here. A smart-account (SCA) signature is ERC-1271 or ERC-6492, and the
   paywall's facilitator has to support that.

## Safety

- The price cap and the payee pin are checked before anything is signed.
- Every signature is checked locally before it leaves the machine.
- A `--dry-run` signature is never sent, and it expires after the server's `maxTimeoutSeconds`.
- The script never prints the API key or the entity secret. On a Circle error it prints Circle's
  status, code and message, not the error object.
- `.env` is written with mode 600. Circle's recovery file is the only way back if the entity
  secret is lost: move it out of `.circle-recovery/` to somewhere offline. Both are gitignored.

## Tests

```bash
npm test
```

Offline: no Circle account, no network, no funds. A local x402 v2 paywall verifies each payment
the way a facilitator does, and a throwaway local key stands in for Circle. The suite covers the
Base and Arc payment round trip, a dry run that sends nothing, a signature from the wrong key that
is never sent, the price cap, the payee pin, Permit2 requirements, v1 servers, and the server's
rejection reason. It also checks the token domain built from the 402 against `DOMAIN_SEPARATOR()`
read from the USDC contracts on Base, Base Sepolia, Arc and Arc Testnet.

## Files

| File | What |
|---|---|
| `circle-x402.mjs` | The CLI: `setup`, `create-wallet`, `derive`, `pay` |
| `lib/x402.mjs` | x402 v2 and EIP-3009 helpers. No Circle code and no secrets, so it can be reused with any EIP-712 signer |
| `test/x402.test.mjs` | The offline tests |
| `.env.example` | Every setting, with comments |

## License

MIT. Made by Predge ([predge.io](https://predge.io), hello@predge.io) while putting Circle Wallets
in front of its own x402 API.
