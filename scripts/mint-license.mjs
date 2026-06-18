#!/usr/bin/env node
// AgentDash on-prem license tool (G2). Dependency-free (Node crypto, ed25519).
//
// Generate a signing keypair (one-time, keep the private key SECRET):
//   node scripts/mint-license.mjs keygen
//     -> writes license-private.pem + prints the public key (SPKI PEM)
//        Put the public key in the install's AGENTDASH_LICENSE_PUBLIC_KEY.
//
// Mint a license for a customer:
//   node scripts/mint-license.mjs mint \
//     --key license-private.pem --customer "Acme Corp" --plan on_prem \
//     --seats 50 --days 365
//     -> prints the token for the install's AGENTDASH_LICENSE_KEY.
//
// Verify a token locally:
//   node scripts/mint-license.mjs verify --pub <spki.pem> --token <token>

import crypto from "node:crypto";
import fs from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (cmd === "keygen") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const out = args.out || "license-private.pem";
  fs.writeFileSync(out, priv, { mode: 0o600 });
  console.error(`Wrote private key -> ${out} (keep this SECRET)`);
  console.log("Public key (set as AGENTDASH_LICENSE_PUBLIC_KEY):\n");
  console.log(pub);
} else if (cmd === "mint") {
  if (!args.key || !args.customer) {
    console.error("Usage: mint --key <private.pem> --customer <name> [--plan p] [--seats n] [--days d]");
    process.exit(1);
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(args.key, "utf8"));
  const claims = { customer: String(args.customer) };
  if (args.plan) claims.plan = String(args.plan);
  if (args.seats) claims.seats = Number(args.seats);
  if (args.days) claims.exp = Math.floor(Date.now() / 1000) + Number(args.days) * 86400;
  const payloadB64 = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = crypto.sign(null, Buffer.from(payloadB64), privateKey);
  console.error("Claims:", JSON.stringify(claims));
  console.log(`${payloadB64}.${b64url(sig)}`);
} else if (cmd === "verify") {
  if (!args.pub || !args.token) {
    console.error("Usage: verify --pub <spki.pem> --token <token>");
    process.exit(1);
  }
  const pub = crypto.createPublicKey(fs.readFileSync(args.pub, "utf8"));
  const [payloadB64, sigB64] = String(args.token).split(".");
  const ok = crypto.verify(null, Buffer.from(payloadB64), pub, b64urlToBuf(sigB64));
  const claims = JSON.parse(b64urlToBuf(payloadB64).toString("utf8"));
  const expired = claims.exp != null && Date.now() > claims.exp * 1000;
  console.log(JSON.stringify({ signatureValid: ok, expired, claims }, null, 2));
  process.exit(ok && !expired ? 0 : 1);
} else {
  console.error("Commands: keygen | mint | verify  (see header of this file)");
  process.exit(1);
}
