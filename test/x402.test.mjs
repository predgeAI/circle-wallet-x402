// Offline tests: no Circle account, no network, no funds. A local x402 v2 paywall verifies
// payments the way a facilitator does, and a throwaway local key stands in for Circle's signer.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { hashDomain, hashTypedData, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  EIP712_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION,
  buildAuthorization,
  buildTypedData,
  chainIdOf,
  fromBase64Json,
  payX402,
  readPaymentRequired,
  selectRequirement,
  toBase64Json,
} from "../lib/x402.mjs";

const PAY_TO = privateKeyToAccount(generatePrivateKey()).address;

// The USDC requirements as Circle's facilitator lists them for Base and Arc (/supported).
const REQ = {
  base: {
    scheme: "exact", network: "eip155:8453", amount: "5000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO, maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  },
  baseSepolia: {
    scheme: "exact", network: "eip155:84532", amount: "5000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: PAY_TO, maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  },
  arc: {
    scheme: "exact", network: "eip155:5042", amount: "5000",
    asset: "0x3600000000000000000000000000000000000000", payTo: PAY_TO, maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  },
  arcTestnet: {
    scheme: "exact", network: "eip155:5042002", amount: "5000",
    asset: "0x3600000000000000000000000000000000000000", payTo: PAY_TO, maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  },
};

// DOMAIN_SEPARATOR() read from each USDC contract on 2 Oct 2026 (Base, Base Sepolia, Arc, Arc Testnet RPCs).
const ONCHAIN_DOMAIN_SEPARATOR = {
  base: "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f",
  baseSepolia: "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818",
  arc: "0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84",
  arcTestnet: "0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0",
};

const SOLANA_REQ = {
  scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "5000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "11111111111111111111111111111111",
  maxTimeoutSeconds: 60, extra: {},
};

const bigints = (m) => ({ ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) });

/** Stands in for Circle: signs the same typed data, the way any local EIP-712 signer would. */
function localSigner(privateKey = generatePrivateKey()) {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signTypedData: ({ domain, types, primaryType, message }) => {
      const { EIP712Domain, ...rest } = types; // a local signer derives the domain type itself
      return account.signTypedData({ domain, types: rest, primaryType, message: bigints(message) });
    },
  };
}

/** A minimal x402 v2 paywall. It verifies a payment the way a facilitator does and never settles. */
async function startPaywall({ accepts, reject = null }) {
  const terms = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: "http://127.0.0.1/paid", description: "test resource", mimeType: "application/json" },
    accepts,
  };
  const seen = { paidAttempts: 0, payloads: [] };
  const server = createServer(async (req, res) => {
    const header = req.headers["payment-signature"];
    if (!header) {
      res.writeHead(402, { "PAYMENT-REQUIRED": toBase64Json(terms), "content-type": "application/json" });
      return res.end("{}");
    }
    seen.paidAttempts += 1;
    const payload = fromBase64Json(header);
    seen.payloads.push(payload);
    const refuse = (error) => {
      res.writeHead(402, { "PAYMENT-REQUIRED": toBase64Json({ ...terms, error }) });
      res.end("{}");
    };
    if (reject) return refuse(reject);
    const accepted = accepts.find((a) => JSON.stringify(a) === JSON.stringify(payload.accepted));
    if (payload.x402Version !== 2 || !accepted) return refuse("invalid_payload");
    const { authorization, signature } = payload.payload;
    const now = Math.floor(Date.now() / 1000);
    if (authorization.to !== accepted.payTo || authorization.value !== accepted.amount) return refuse("terms_mismatch");
    if (BigInt(authorization.validBefore) <= BigInt(now) || BigInt(authorization.validAfter) > BigInt(now)) return refuse("expired");
    const ok = await verifyTypedData({
      address: authorization.from,
      domain: {
        name: accepted.extra.name, version: accepted.extra.version,
        chainId: chainIdOf(accepted.network), verifyingContract: accepted.asset,
      },
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
      primaryType: "TransferWithAuthorization",
      message: bigints(authorization),
      signature,
    });
    if (!ok) return refuse("invalid_exact_evm_payload_signature");
    const receipt = { success: true, transaction: "0x" + "ab".repeat(32), network: accepted.network, payer: authorization.from };
    res.writeHead(200, { "PAYMENT-RESPONSE": toBase64Json(receipt), "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/paid`;
  return { url, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("chain ids come from CAIP-2 network ids, and only EVM ones are accepted", () => {
  assert.equal(chainIdOf("eip155:8453"), 8453);
  assert.equal(chainIdOf("eip155:5042"), 5042);
  assert.throws(() => chainIdOf(SOLANA_REQ.network), /not an EVM network/);
});

test("the token domain built from the 402 matches the USDC contract on-chain", () => {
  for (const [key, requirement] of Object.entries(REQ)) {
    const auth = buildAuthorization({ from: PAY_TO, requirement });
    const { domain, types } = buildTypedData(requirement, auth);
    assert.equal(hashDomain({ domain, types }), ONCHAIN_DOMAIN_SEPARATOR[key], key);
  }
});

test("EIP712Domain is spelled out for Circle and leaves the digest unchanged", () => {
  const auth = buildAuthorization({ from: PAY_TO, requirement: REQ.arc });
  const td = buildTypedData(REQ.arc, auth);
  assert.deepEqual(td.types.EIP712Domain, EIP712_DOMAIN);
  const withDomainType = hashTypedData({ ...td, message: bigints(td.message) });
  const inferred = hashTypedData({
    domain: td.domain,
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: td.primaryType,
    message: bigints(td.message),
  });
  assert.equal(withDomainType, inferred);
});

test("the authorization uses the server's price, payee and settlement window", () => {
  const auth = buildAuthorization({ from: PAY_TO, requirement: REQ.base, now: 1_000 });
  assert.equal(auth.to, PAY_TO);
  assert.equal(auth.value, "5000");
  assert.equal(auth.validAfter, "0");
  assert.equal(auth.validBefore, "1060");
  assert.match(auth.nonce, /^0x[0-9a-f]{64}$/);
});

test("requirement selection: network, Permit2, missing domain, cap and payee pin", () => {
  const accepts = [SOLANA_REQ, REQ.base, REQ.arc];
  assert.equal(selectRequirement(accepts, { network: "eip155:5042", maxAmount: "10000" }), REQ.arc);
  assert.equal(selectRequirement(accepts, { network: "eip155:8453", maxAmount: "10000" }), REQ.base);
  assert.throws(() => selectRequirement(accepts, { network: "eip155:42161", maxAmount: "10000" }), /no "exact" requirement/);
  assert.throws(() => selectRequirement(accepts, { network: "eip155:8453", maxAmount: "4999" }), /above the cap/);
  assert.throws(
    () => selectRequirement(accepts, { network: "eip155:8453", maxAmount: "10000", payTo: SOLANA_REQ.payTo }),
    /expected/,
  );
  const permit2 = { ...REQ.base, extra: { ...REQ.base.extra, assetTransferMethod: "permit2" } };
  assert.throws(() => selectRequirement([permit2], { network: "eip155:8453", maxAmount: "10000" }), /EIP-3009 only/);
  const noDomain = { ...REQ.base, extra: {} };
  assert.throws(() => selectRequirement([noDomain], { network: "eip155:8453", maxAmount: "10000" }), /name\/version/);
});

test("402 parsing: v2 header first, body as fallback, v1 refused", () => {
  const terms = { x402Version: 2, accepts: [REQ.base] };
  assert.deepEqual(readPaymentRequired(new Headers({ "payment-required": toBase64Json(terms) })), terms);
  assert.deepEqual(readPaymentRequired(new Headers(), JSON.stringify(terms)), terms);
  assert.throws(() => readPaymentRequired(new Headers(), JSON.stringify({ x402Version: 1, accepts: [] })), /v1/);
  assert.throws(() => readPaymentRequired(new Headers(), "not json"), /no x402 v2/);
});

for (const [name, requirement] of [["Arc", REQ.arc], ["Base", REQ.base]]) {
  test(`end to end on ${name}: the paywall verifies the signature and returns the resource`, async () => {
    const paywall = await startPaywall({ accepts: [SOLANA_REQ, REQ.base, REQ.arc] });
    try {
      const signer = localSigner();
      const out = await payX402({ url: paywall.url, signer, network: requirement.network, maxAmount: "10000" });
      assert.equal(out.status, 200);
      assert.equal(out.paid, true);
      assert.equal(out.settlement.network, requirement.network);
      assert.equal(out.settlement.payer, signer.address);
      assert.equal(paywall.seen.paidAttempts, 1);
      const payload = paywall.seen.payloads[0];
      assert.deepEqual(payload.accepted, requirement);
      assert.equal(payload.resource.description, "test resource");
    } finally {
      await paywall.close();
    }
  });
}

test("dry run signs and checks, and sends nothing", async () => {
  const paywall = await startPaywall({ accepts: [REQ.arc] });
  try {
    const out = await payX402({ url: paywall.url, signer: localSigner(), network: "eip155:5042", maxAmount: "10000", dryRun: true });
    assert.equal(out.dryRun, true);
    assert.equal(out.paid, false);
    assert.equal(paywall.seen.paidAttempts, 0);
  } finally {
    await paywall.close();
  }
});

test("a signature that does not recover to the wallet is never sent", async () => {
  const paywall = await startPaywall({ accepts: [REQ.base] });
  try {
    const wallet = localSigner();
    const impostor = localSigner();
    const signer = { address: wallet.address, signTypedData: impostor.signTypedData };
    await assert.rejects(
      payX402({ url: paywall.url, signer, network: "eip155:8453", maxAmount: "10000" }),
      /recovers to .* nothing was sent/,
    );
    assert.equal(paywall.seen.paidAttempts, 0);
  } finally {
    await paywall.close();
  }
});

test("over the cap: refused before anything is signed or sent", async () => {
  const paywall = await startPaywall({ accepts: [REQ.base] });
  try {
    let signed = 0;
    const s = localSigner();
    const signer = { address: s.address, signTypedData: (td) => { signed += 1; return s.signTypedData(td); } };
    await assert.rejects(payX402({ url: paywall.url, signer, network: "eip155:8453", maxAmount: "1000" }), /above the cap/);
    assert.equal(signed, 0);
    assert.equal(paywall.seen.paidAttempts, 0);
  } finally {
    await paywall.close();
  }
});

test("a refused payment reports the server's reason", async () => {
  const paywall = await startPaywall({ accepts: [REQ.base], reject: "insufficient_funds" });
  try {
    const out = await payX402({ url: paywall.url, signer: localSigner(), network: "eip155:8453", maxAmount: "10000" });
    assert.equal(out.paid, false);
    assert.equal(out.status, 402);
    assert.equal(out.rejection, "insufficient_funds");
  } finally {
    await paywall.close();
  }
});

test("a free resource is returned without signing anything", async () => {
  const server = createServer((req, res) => res.end("free"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const signer = { address: PAY_TO, signTypedData: () => assert.fail("must not sign") };
    const out = await payX402({ url: `http://127.0.0.1:${server.address().port}/`, signer, network: "eip155:8453", maxAmount: "1" });
    assert.equal(out.status, 200);
    assert.equal(out.body, "free");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
