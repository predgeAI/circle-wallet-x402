#!/usr/bin/env node
// Pay an x402 v2 paywall from a Circle developer-controlled wallet.
//
//   node circle-x402.mjs setup                     one time: create and register an entity secret
//   node circle-x402.mjs create-wallet [CHAIN]     create a wallet set and one EOA wallet (default BASE)
//   node circle-x402.mjs derive <CHAIN>            the same address on another EVM chain, e.g. ARC
//   node circle-x402.mjs pay [url] [--dry-run]     pay for `url` (or X402_URL) and print the answer
//
// The agent holds no private key and no gas. Circle holds the key and signs an EIP-3009
// authorization; the paywall's facilitator submits it. Configuration is read from the
// environment or from a .env file next to this script, see .env.example.

import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  initiateDeveloperControlledWalletsClient,
  registerEntitySecretCiphertext,
} from "@circle-fin/developer-controlled-wallets";
import { CIRCLE_CHAINS, explorerTx, payX402 } from "./lib/x402.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ENV_FILE = HERE + ".env";
try {
  process.loadEnvFile(ENV_FILE); // never overrides variables already set in the environment
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const env = (name, fallback = undefined) => {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
};
const need = (name) => env(name) ?? fail(`${name} is not set. Copy .env.example to .env and fill it in.`);

/** Appends NAME=value to .env, creating it readable by the owner only. */
function saveToEnv(name, value) {
  appendFileSync(ENV_FILE, `\n${name}=${value}\n`, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

function checkChain(chain) {
  if (!(chain in CIRCLE_CHAINS)) fail(`unsupported chain ${chain}. Use one of: ${Object.keys(CIRCLE_CHAINS).join(", ")}`);
}

const circle = () =>
  initiateDeveloperControlledWalletsClient({
    apiKey: need("CIRCLE_API_KEY"),
    entitySecret: need("CIRCLE_ENTITY_SECRET"),
  });

/**
 * One time per Circle account and environment (TEST and LIVE keys are separate). Circle stores
 * only a ciphertext of the secret, so it is generated here and cannot be fetched back later.
 */
async function setup() {
  if (env("CIRCLE_ENTITY_SECRET")) {
    fail("CIRCLE_ENTITY_SECRET is already set. It is registered once; remove it from .env only if you mean to replace it.");
  }
  const apiKey = need("CIRCLE_API_KEY");
  const dir = env("CIRCLE_RECOVERY_DIR", HERE + ".circle-recovery");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entitySecret = randomBytes(32).toString("hex");
  await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: dir });
  saveToEnv("CIRCLE_ENTITY_SECRET", entitySecret);
  console.log("\nEntity secret registered with Circle and written to .env (mode 600).");
  console.log(`Circle's recovery file is in ${dir}`);
  console.log("It is the only way back if the secret is lost. Move it somewhere safe and never commit it.");
  console.log("\nNext: node circle-x402.mjs create-wallet BASE");
}

async function createWallet(chain) {
  checkChain(chain);
  if (env("CIRCLE_WALLET_ID")) fail("CIRCLE_WALLET_ID is already set. Remove it from .env to create another wallet.");
  const client = circle();
  const set = await client.createWalletSet({ name: "x402 agent wallets" });
  const walletSetId = set.data?.walletSet?.id ?? fail("Circle returned no wallet set");
  const made = await client.createWallets({ walletSetId, blockchains: [chain], count: 1, accountType: "EOA" });
  const w = made.data?.wallets?.[0] ?? fail("Circle returned no wallet");
  saveToEnv("CIRCLE_WALLET_ID", w.id);
  console.log(`\nwallet   ${w.id}  (written to .env)`);
  console.log(`address  ${w.address}  (${w.blockchain}, ${w.accountType})`);
  console.log(`\nSend a little USDC on ${chain} to that address. No native gas is needed to pay x402.`);
}

/** EVM EOAs in Circle are one key on many chains: deriving gives the same address a wallet id on `chain`. */
async function derive(chain) {
  if (!chain) fail("usage: node circle-x402.mjs derive <CHAIN>   e.g. derive ARC");
  checkChain(chain);
  const client = circle();
  const r = await client.deriveWallet({ id: need("CIRCLE_WALLET_ID"), blockchain: chain });
  const w = r.data?.wallet ?? fail("Circle returned no wallet");
  console.log(`\nwallet   ${w.id}`);
  console.log(`address  ${w.address}  (${w.blockchain}, same key as the source wallet)`);
  console.log(`\nTo pay on ${chain}, run with CIRCLE_WALLET_ID=${w.id}`);
}

async function pay(args) {
  const dryRun = args.includes("--dry-run");
  const url = args.find((a) => !a.startsWith("--")) ?? need("X402_URL");
  const walletId = need("CIRCLE_WALLET_ID");
  const client = circle();

  const wallet = (await client.getWallet({ id: walletId })).data?.wallet ?? fail(`wallet ${walletId} not found`);
  if (wallet.accountType && wallet.accountType !== "EOA") {
    fail(`wallet ${walletId} is an ${wallet.accountType}. This reference signs with EOA wallets only: a smart-account ` +
      "signature needs ERC-1271/6492 support from the facilitator.");
  }
  const chainId = CIRCLE_CHAINS[wallet.blockchain]
    ?? fail(`the wallet is on ${wallet.blockchain}; supported: ${Object.keys(CIRCLE_CHAINS).join(", ")}`);
  const walletNetwork = `eip155:${chainId}`;
  const network = env("X402_PAY_NETWORK", walletNetwork);
  if (network !== walletNetwork) {
    fail(`X402_PAY_NETWORK is ${network}, but this wallet is on ${wallet.blockchain} (${walletNetwork}).\n` +
      "Circle signs only for the chain a wallet belongs to. Run `derive` for that chain and use the new wallet id.");
  }
  const maxAmount = env("X402_MAX_AMOUNT", "10000");
  if (!/^\d+$/.test(maxAmount)) fail(`X402_MAX_AMOUNT must be an integer in atomic units, got ${maxAmount}`);
  const body = env("X402_BODY");
  const init = {
    method: env("X402_METHOD", "GET").toUpperCase(),
    ...(body ? { body, headers: { "content-type": env("X402_CONTENT_TYPE", "application/json") } } : {}),
  };

  // The only place a key is used, and it is not ours: Circle signs the typed data.
  const signer = {
    address: wallet.address,
    async signTypedData(typedData) {
      const r = await client.signTypedData({
        walletId,
        data: JSON.stringify(typedData),
        memo: `x402: ${typedData.message.value} atomic units to ${typedData.message.to}`,
      });
      return r.data?.signature ?? fail("Circle returned no signature");
    },
  };

  console.log(`\nresource   ${url}`);
  console.log(`payer      ${wallet.address}  (Circle developer-controlled wallet, ${wallet.blockchain})`);
  const out = await payX402({
    url,
    init,
    signer,
    network,
    maxAmount,
    payTo: env("X402_EXPECT_PAY_TO"),
    dryRun,
    onEvent: (e) => {
      if (e.step === "terms") {
        console.log(`price      ${e.requirement.amount} atomic units of ${e.requirement.asset} on ${e.requirement.network} (cap ${maxAmount})`);
        console.log(`payee      ${e.requirement.payTo}`);
      }
      if (e.step === "signed") console.log(`signature  ${e.signature.slice(0, 18)}…  signed by Circle, recovered locally to the payer`);
    },
  });

  if (out.note) {
    console.log(`\nHTTP ${out.status}: ${out.note}`);
    if (out.body) console.log("\n" + out.body.slice(0, 600));
    if (out.status >= 400) process.exit(1);
    return;
  }
  if (out.dryRun) {
    console.log("\n--dry-run: the authorization was signed and checked, and NOT sent. Nothing was paid.");
    return;
  }
  console.log(`\nHTTP ${out.status}`);
  if (out.settlement) {
    const tx = out.settlement.transaction;
    console.log(`settlement ${out.settlement.success === false ? "FAILED" : "ok"}  ${tx ?? ""}  ${out.settlement.network ?? ""}`);
    const link = explorerTx(out.settlement.network ?? network, tx);
    if (link) console.log(`explorer   ${link}`);
  }
  if (out.rejection) console.log(`rejected   ${out.rejection}`);
  console.log("\n" + out.body.slice(0, 600) + (out.body.length > 600 ? "\n…" : ""));
  if (!out.paid) process.exit(1);
}

const [first, ...rest] = process.argv.slice(2);
const command = !first || first.startsWith("--") || /^https?:/.test(first) ? "pay" : first;
const args = command === "pay" && first !== "pay" ? [first, ...rest].filter(Boolean) : rest;

try {
  if (command === "setup") await setup();
  else if (command === "create-wallet") await createWallet(args[0] ?? env("CIRCLE_BLOCKCHAIN", "BASE"));
  else if (command === "derive") await derive(args[0]);
  else if (command === "pay") await pay(args);
  else fail(`unknown command ${command}. Commands: setup, create-wallet, derive, pay`);
} catch (e) {
  // Print Circle's status, code and message only, never the error object: an HTTP client error
  // can carry the request headers, and the API key travels in them.
  const status = e?.status ?? e?.response?.status;
  const code = e?.response?.data?.code ?? (status ? e?.code : undefined);
  const message = e?.response?.data?.message ?? e?.message ?? String(e);
  const cause = e?.cause ? ` (${e.cause.code ?? e.cause.message})` : "";
  fail(status ? `Circle API error ${status}${code ? ` [${code}]` : ""}: ${message}` : `${message}${cause}`);
}
