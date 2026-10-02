// x402 v2 "exact" payments on EVM chains, signed by any EIP-712 signer.
//
// On an EVM chain the x402 "exact" scheme is an EIP-3009 transferWithAuthorization: the payer
// signs typed data, the facilitator submits it and pays the gas. The payer never sends a
// transaction and needs no native gas, only USDC. That is why a Circle developer-controlled
// wallet can pay: Circle holds the key and exposes signTypedData, and nothing else is needed.
//
// This file talks to no wallet provider and holds no secret, so all of it is testable offline.

import { randomBytes } from "node:crypto";
import { recoverTypedDataAddress } from "viem";

/** Circle blockchain code -> EVM chain id, for the chains this reference was checked against. */
export const CIRCLE_CHAINS = {
  BASE: 8453,
  "BASE-SEPOLIA": 84532,
  ARC: 5042,
  "ARC-TESTNET": 5042002,
};

const EXPLORER_TX = {
  8453: "https://basescan.org/tx/",
  84532: "https://sepolia.basescan.org/tx/",
  5042: "https://explorer.arc.io/tx/",
  5042002: "https://explorer.testnet.arc.io/tx/",
};

/**
 * Circle's signTypedData rejects typed data whose `types` omit EIP712Domain ("there is extra
 * data provided in the message"). Most signers infer it, so most examples leave it out.
 * Spelling it out changes nothing in the digest: it is the same type every verifier derives.
 */
export const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

export const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

/** "eip155:5042" -> 5042. Anything that is not an EVM CAIP-2 id is rejected. */
export function chainIdOf(network) {
  const m = /^eip155:(\d+)$/.exec(String(network));
  if (!m) throw new Error(`not an EVM network: ${network} (expected eip155:<chainId>)`);
  return Number(m[1]);
}

export const toBase64Json = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
export const fromBase64Json = (text) => JSON.parse(Buffer.from(text, "base64").toString("utf8"));

/**
 * The payment terms of a 402. x402 v2 sends them as base64 JSON in the PAYMENT-REQUIRED header;
 * the body is only a fallback for servers that also put the same object there.
 */
export function readPaymentRequired(headers, bodyText = "") {
  const header = headers.get("payment-required");
  let terms;
  if (header) {
    terms = fromBase64Json(header);
  } else {
    try { terms = JSON.parse(bodyText); } catch { terms = undefined; }
  }
  if (terms?.x402Version === 1) {
    throw new Error("this server speaks x402 v1 (X-PAYMENT); this client implements v2 only");
  }
  if (terms?.x402Version !== 2 || !Array.isArray(terms.accepts) || terms.accepts.length === 0) {
    throw new Error("the 402 carries no x402 v2 payment terms (no PAYMENT-REQUIRED header)");
  }
  return terms;
}

/**
 * The one requirement this wallet can pay: scheme "exact" on the wallet's own network, settled
 * by EIP-3009 rather than Permit2, with the token's EIP-712 name and version supplied by the
 * server, at or under the price cap and, when a payee is pinned, paying that payee.
 */
export function selectRequirement(accepts, { network, maxAmount, payTo }) {
  const offered = [...new Set(accepts.map((a) => `${a.scheme} ${a.network}`))].join(", ");
  const candidates = accepts.filter((a) => a.scheme === "exact" && a.network === network);
  if (candidates.length === 0) {
    throw new Error(`no "exact" requirement on ${network}. The server offers: ${offered}`);
  }
  const reasons = [];
  for (const a of candidates) {
    const method = a.extra?.assetTransferMethod ?? "eip3009";
    if (method !== "eip3009") { reasons.push(`asks for ${method}; this client signs EIP-3009 only`); continue; }
    if (!a.extra?.name || !a.extra?.version) { reasons.push("no EIP-712 name/version in `extra`"); continue; }
    if (BigInt(a.amount) > BigInt(maxAmount)) { reasons.push(`costs ${a.amount}, above the cap of ${maxAmount}`); continue; }
    if (payTo && String(a.payTo).toLowerCase() !== payTo.toLowerCase()) { reasons.push(`pays ${a.payTo}, expected ${payTo}`); continue; }
    return a;
  }
  throw new Error(`refusing to pay on ${network}: ${reasons.join("; ")}`);
}

/** The EIP-3009 authorization. validBefore is the window the server says it will settle in. */
export function buildAuthorization({ from, requirement, now = Math.floor(Date.now() / 1000), nonce }) {
  return {
    from,
    to: requirement.payTo,
    value: String(requirement.amount),
    validAfter: "0",
    validBefore: String(now + Number(requirement.maxTimeoutSeconds || 60)),
    nonce: nonce ?? "0x" + randomBytes(32).toString("hex"),
  };
}

/** The typed data to sign. The token's own domain comes from the 402, never from this client. */
export function buildTypedData(requirement, authorization) {
  return {
    types: { EIP712Domain: EIP712_DOMAIN, TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: "TransferWithAuthorization",
    domain: {
      name: requirement.extra.name,
      version: requirement.extra.version,
      chainId: chainIdOf(requirement.network),
      verifyingContract: requirement.asset,
    },
    message: authorization,
  };
}

/** Recovers the address that produced `signature` over `typedData`, the way a facilitator does. */
export function recoverSigner(typedData, signature) {
  const { domain, message } = typedData;
  return recoverTypedDataAddress({
    domain,
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: "TransferWithAuthorization",
    message: {
      ...message,
      value: BigInt(message.value),
      validAfter: BigInt(message.validAfter),
      validBefore: BigInt(message.validBefore),
    },
    signature,
  });
}

/** The x402 v2 PaymentPayload: the chosen requirement echoed back as `accepted`. */
export function buildPaymentPayload(terms, requirement, authorization, signature) {
  return {
    x402Version: 2,
    ...(terms.resource ? { resource: terms.resource } : {}),
    accepted: requirement,
    payload: { signature, authorization },
    ...(terms.extensions ? { extensions: terms.extensions } : {}),
  };
}

/** The settlement receipt from PAYMENT-RESPONSE (X-PAYMENT-RESPONSE on older servers). */
export function readSettlement(headers) {
  const header = headers.get("payment-response") ?? headers.get("x-payment-response");
  if (!header) return null;
  try { return fromBase64Json(header); } catch { return { raw: header }; }
}

export function explorerTx(network, tx) {
  try {
    const base = EXPLORER_TX[chainIdOf(network)];
    return base && tx ? base + tx : null;
  } catch {
    return null;
  }
}

/**
 * The whole exchange: request, read the 402, sign, check the signature, pay, read the receipt.
 *
 * `signer` is { address, signTypedData(typedData) -> "0x…" }. A payment is never sent unless the
 * signature recovers to `signer.address`, so a signer that signs the wrong thing, or with the
 * wrong key, fails here instead of at the facilitator.
 */
export async function payX402({
  url,
  init = {},
  signer,
  network,
  maxAmount,
  payTo,
  dryRun = false,
  fetchImpl = fetch,
  onEvent = () => {},
}) {
  const first = await fetchImpl(url, init);
  const firstBody = await first.text();
  if (first.status !== 402) {
    return { paid: false, status: first.status, body: firstBody, note: "the server did not ask for payment" };
  }

  const terms = readPaymentRequired(first.headers, firstBody);
  const requirement = selectRequirement(terms.accepts, { network, maxAmount, payTo });
  const authorization = buildAuthorization({ from: signer.address, requirement });
  const typedData = buildTypedData(requirement, authorization);
  onEvent({ step: "terms", requirement });

  const signature = await signer.signTypedData(typedData);
  const recovered = await recoverSigner(typedData, signature);
  if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`the signature recovers to ${recovered}, not to the wallet ${signer.address}; nothing was sent`);
  }
  onEvent({ step: "signed", signature });
  if (dryRun) return { paid: false, dryRun: true, requirement, authorization, signature };

  const headers = new Headers(init.headers);
  headers.set("PAYMENT-SIGNATURE", toBase64Json(buildPaymentPayload(terms, requirement, authorization, signature)));
  const second = await fetchImpl(url, { ...init, headers });
  const body = await second.text();
  let rejection;
  if (second.status === 402) {
    try { rejection = readPaymentRequired(second.headers, body).error; } catch { rejection = undefined; }
  }
  return {
    paid: second.ok,
    status: second.status,
    requirement,
    authorization,
    signature,
    settlement: readSettlement(second.headers),
    rejection,
    body,
  };
}
