#!/usr/bin/env node
// AgentDash: the per-sandbox signer daemon (spike R2/R4). Self-contained —
// runs inside the sandbox image as the `signer` OS user; the repo is not
// available there.
//
//   node signerd.mjs --socket PATH --policy FILE --key-file FILE \
//                    [--state-dir DIR] [--generate]
//
// Holds TWO kinds of key:
//   - a long-term "company" key loaded from --key-file (prototype: a PEM the
//     entrypoint generates with --generate, mode 0400, owned by `signer`;
//     Phase 1: an AWS KMS key via the adapter in cloud/src/sandbox/
//     key-source.ts — the daemon then holds only the key id, never material)
//   - per-session keys minted by `init` (in-memory only; `clear` forgets them)
//
// The family principal's key never enters the sandbox: mandates arrive
// pre-signed and are relayed as opaque payloads by the agent.
//
// Protocol: newline-delimited JSON on the unix socket.
//   {"op":"init",      "sessionId":"…"}            -> {ok, publicKeyPem, keyId}
//   {"op":"publicKey", "sessionId":"…"}            -> {ok, publicKeyPem}
//   {"op":"sign",      "sessionId":"…", "artifactType":"…", "payloadB64":"…"}
//                                                  -> {ok, signatureB64, publicKeyPem}
//   {"op":"companyPublicKey"}                      -> {ok, publicKeyPem}
//   {"op":"clear",     "sessionId":"…"}            -> {ok}
//   {"op":"health"}                                 -> {ok, sessions:N, keySource:"file"}
// Errors: {"ok":false,"error":{"code":"…","message":"…"}}
//
// Policy file (JSON, schema = signerPolicySchema in cloud/src/sandbox/
// signer-policy.ts — keep the check below and that schema in sync):
//   {
//     "maxPayloadBytes": 65536,
//     "artifactTypes": {
//       "handshake_proposal":   {"key": "session"},
//       "handshake_acceptance": {"key": "session"},
//       "checkpoint":           {"key": "session"},
//       "daily_report":         {"key": "company"}
//     }
//   }
// Anything not listed is refused. Signing the family principal's artifacts is
// impossible by construction — there is no key for it here.

import {
  createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export function checkSignRequest(policy, req) {
  const t = policy.artifactTypes?.[req.artifactType];
  if (!t) return { ok: false, code: "policy_denied", message: `artifactType ${req.artifactType} not in policy` };
  const bytes = Buffer.from(req.payloadB64 ?? "", "base64");
  if (bytes.length > (policy.maxPayloadBytes ?? 65536)) {
    return { ok: false, code: "payload_too_large", message: `${bytes.length}B exceeds maxPayloadBytes` };
  }
  return { ok: true, keyScope: t.key ?? "session" };
}

// Load or mint the company key, refusing a key file any non-owner could read.
function loadCompanyKey(keyFile, generate) {
  if (!existsSync(keyFile)) {
    if (!generate) throw new Error(`key file ${keyFile} missing (pass --generate for the prototype)`);
    mkdirSync(dirname(keyFile), { recursive: true });
    const pair = generateKeyPairSync("ed25519");
    writeFileSync(keyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o400 });
  }
  const st = statSync(keyFile);
  if (st.mode & 0o077) throw new Error(`key file ${keyFile} mode ${(st.mode & 0o777).toString(8)} is readable by group/other — refusing`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`key file ${keyFile} owned by uid ${st.uid}, daemon runs as ${process.getuid()} — refusing`);
  }
  return createPrivateKey(readFileSync(keyFile));
}

export function createSigner(policy, companyKey) {
  const sessions = new Map(); // sessionId -> {privateKey, publicKeyPem}
  const companyPubPem = companyKey ? createPublicKey(companyKey).export({ type: "spki", format: "pem" }).toString() : null;

  function sessionKey(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return null;
    return s;
  }

  return {
    handle(raw) {
      let req;
      try {
        req = JSON.parse(raw);
      } catch {
        return { ok: false, error: { code: "bad_request", message: "not JSON" } };
      }
      const op = req.op;
      try {
        if (op === "health") {
          return { ok: true, sessions: sessions.size, keySource: companyKey ? "file" : "none" };
        }
        if (op === "init") {
          const sessionId = String(req.sessionId ?? "");
          if (!sessionId) return { ok: false, error: { code: "bad_request", message: "sessionId required" } };
          if (!sessions.has(sessionId)) {
            const pair = generateKeyPairSync("ed25519");
            sessions.set(sessionId, {
              privateKey: pair.privateKey,
              publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
            });
          }
          return { ok: true, sessionId, publicKeyPem: sessions.get(sessionId).publicKeyPem, keyId: `ed25519:${sessionId}` };
        }
        if (op === "publicKey") {
          const s = sessionKey(String(req.sessionId ?? ""));
          if (!s) return { ok: false, error: { code: "unknown_session", message: "no key for sessionId" } };
          return { ok: true, publicKeyPem: s.publicKeyPem };
        }
        if (op === "companyPublicKey") {
          if (!companyPubPem) return { ok: false, error: { code: "no_company_key", message: "no company key loaded" } };
          return { ok: true, publicKeyPem: companyPubPem };
        }
        if (op === "sign") {
          const check = checkSignRequest(policy, req);
          if (!check.ok) return { ok: false, error: { code: check.code, message: check.message } };
          const payload = Buffer.from(String(req.payloadB64 ?? ""), "base64");
          let key;
          let publicKeyPem;
          if (check.keyScope === "company") {
            if (!companyKey) return { ok: false, error: { code: "no_company_key", message: "no company key loaded" } };
            key = companyKey;
            publicKeyPem = companyPubPem;
          } else {
            const s = sessionKey(String(req.sessionId ?? ""));
            if (!s) return { ok: false, error: { code: "unknown_session", message: "init the session first" } };
            key = s.privateKey;
            publicKeyPem = s.publicKeyPem;
          }
          const sig = cryptoSign(null, payload, key);
          return { ok: true, signatureB64: sig.toString("base64"), publicKeyPem };
        }
        if (op === "clear") {
          const sessionId = String(req.sessionId ?? "");
          sessions.delete(sessionId);
          return { ok: true };
        }
        return { ok: false, error: { code: "bad_request", message: `unknown op ${String(op)}` } };
      } catch (err) {
        return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
      }
    },
  };
}

export function verifySignature(publicKeyPem, payloadB64, signatureB64) {
  return cryptoVerify(
    null,
    Buffer.from(payloadB64, "base64"),
    createPublicKey(publicKeyPem),
    Buffer.from(signatureB64, "base64"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const socketPath = arg("socket", "/run/sandbox-signer/sign.sock");
  const policyFile = arg("policy", "/etc/sandbox-signer/policy.json");
  const keyFile = arg("key-file", null);
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  const companyKey = keyFile ? loadCompanyKey(keyFile, hasFlag("generate")) : null;
  const signer = createSigner(policy, companyKey);

  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        conn.write(JSON.stringify(signer.handle(line)) + "\n");
      }
    });
  });
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o660); // group = signsock: agent+svc may connect
    process.stdout.write(`signerd listening on ${socketPath}\n`);
  });
}
