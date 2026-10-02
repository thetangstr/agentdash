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
//       "handshake_proposal":   {"key": "session", "payloadFormat": "json-object"},
//       "handshake_acceptance": {"key": "session", "payloadFormat": "json-object"},
//       "checkpoint":           {"key": "session", "payloadFormat": "json-object"},
//       "daily_report":         {"key": "company", "payloadFormat": "utf8"}
//     }
//   }
// Anything not listed is refused — lookup is by own-property only, so
// inherited names ("constructor", "__proto__", "toString") deny. Signing the
// family principal's artifacts is impossible by construction — there is no
// key for it here.
//
// Signed bytes are domain-separated: what actually gets signed is
//   "agentdash-sandbox-sign/v1\n" ++ artifactType ++ "\n" ++ payload
// so a signature can never be re-interpreted as raw payload bytes or under a
// different artifact type. Verifiers reconstruct the same byte string.

import {
  createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export const SIGN_TAG_PREFIX = "agentdash-sandbox-sign/v1";

/** The exact byte string signerd signs: tag || artifactType || payload. */
export function taggedPayload(artifactType, payload) {
  return Buffer.concat([
    Buffer.from(`${SIGN_TAG_PREFIX}\n`, "utf8"),
    Buffer.from(`${artifactType}\n`, "utf8"),
    payload,
  ]);
}

function payloadFormatOk(format, bytes) {
  switch (format ?? "bytes") {
    case "bytes":
      return true;
    case "utf8":
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
      } catch {
        return false;
      }
    case "json-object":
      try {
        const v = JSON.parse(bytes.toString("utf8"));
        return typeof v === "object" && v !== null && !Array.isArray(v);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export function checkSignRequest(policy, req) {
  const types = policy?.artifactTypes;
  const name = String(req.artifactType ?? "");
  // Own-property lookup: Object.prototype members (constructor, __proto__,
  // toString, hasOwnProperty…) must NOT be readable as policy entries.
  if (!types || typeof types !== "object" || !Object.hasOwn(types, name)) {
    return { ok: false, code: "policy_denied", message: `artifactType ${name} not in policy` };
  }
  const t = types[name];
  if (!t || typeof t !== "object" || (t.key !== "session" && t.key !== "company")) {
    return { ok: false, code: "bad_policy", message: `policy entry for ${name} has no valid key scope` };
  }
  const bytes = Buffer.from(req.payloadB64 ?? "", "base64");
  if (bytes.length > (policy.maxPayloadBytes ?? 65536)) {
    return { ok: false, code: "payload_too_large", message: `${bytes.length}B exceeds maxPayloadBytes` };
  }
  if (!payloadFormatOk(t.payloadFormat, bytes)) {
    return { ok: false, code: "invalid_payload", message: `payload does not match format ${t.payloadFormat} for ${name}` };
  }
  return { ok: true, keyScope: t.key };
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
          const artifactType = String(req.artifactType);
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
          const sig = cryptoSign(null, taggedPayload(artifactType, payload), key);
          return { ok: true, signatureB64: sig.toString("base64"), publicKeyPem, artifactType };
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

export function verifySignature(publicKeyPem, artifactType, payloadB64, signatureB64) {
  return cryptoVerify(
    null,
    taggedPayload(artifactType, Buffer.from(payloadB64, "base64")),
    createPublicKey(publicKeyPem),
    Buffer.from(signatureB64, "base64"),
  );
}

// If a previous signerd died without unlinking its socket, bind() would fail
// EADDRINUSE forever. Probe the path: a live listener means refuse to start
// (two daemons must never share the socket); a dead one gets unlinked.
async function claimSocket(socketPath) {
  if (!existsSync(socketPath)) return;
  const st = statSync(socketPath);
  if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket — refusing`);
  const alive = await new Promise((res) => {
    const c = connect(socketPath);
    c.setTimeout(300);
    c.once("connect", () => { c.destroy(); res(true); });
    c.once("error", () => res(false));
    c.once("timeout", () => { c.destroy(); res(false); });
  });
  if (alive) throw new Error(`${socketPath} is a live signerd socket — refusing to start`);
  rmSync(socketPath, { force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const socketPath = arg("socket", "/run/sandbox-signer/sign.sock");
  const policyFile = arg("policy", "/etc/sandbox-signer/policy.json");
  const keyFile = arg("key-file", null);
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  const companyKey = keyFile ? loadCompanyKey(keyFile, hasFlag("generate")) : null;
  const signer = createSigner(policy, companyKey);

  mkdirSync(dirname(socketPath), { recursive: true });
  await claimSocket(socketPath);
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
