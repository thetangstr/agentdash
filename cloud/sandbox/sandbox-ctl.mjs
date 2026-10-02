#!/usr/bin/env node
// AgentDash: the in-guest lifecycle agent (spike R4/R9). Self-contained —
// runs inside the sandbox image; the EC2 driver invokes it over SSM
// SendCommand and the local "fake VM" driver spawns it in a temp dir.
//
//   node sandbox-ctl.mjs --state DIR --socket PATH <command> [jsonArg]
//
// Commands (JSON in -> JSON out on stdout):
//   open-handshake      {"side":"buyer"|"seller"}                -> {sessionId, side, state, openedAt}
//   list-handshakes     {}                                       -> {sessions:[{sessionId,side,state,openedAt}]}
//   apply-run-config    {"runId","sessionId","agentConfigRevision"}
//                     -> {runId, sessionId, signerPublicKeyPem, adapterPublicKeyPem,
//                         forwarderSealingPublicKeyB64}
//   install-sink-token  {"runId","sealedTokenB64"}               -> {runId, tokenDigest}
//   clear               {"runId"?}                               -> {clearedAt}
//   gen-evidence        {"runId"}                                -> evidence record (raw material for R8)
//   health              {}                                       -> per-sandbox health check (R9)
//
// State lives under --state (image: /run/sandbox — tmpfs, wiped on stop):
//   state.json            sessions + applied runs
//   events.jsonl          append-only run/wake event log (evidence exclusivity)
//   adapter-key.pem       per-run Clockchain adapter key (svc-readable)
//   forwarder-key.pem     per-sandbox forwarder sealing keypair (svc-readable)
//   sink-token.sealed     run's sealed ingest token — ciphertext only
//
// Ordering is enforced HERE, in the guest, not only in the control plane: a
// confused or replayed control-plane call sequence cannot, say, install a
// token for a run that was never configured. `clear` is the exception — it is
// always callable, always succeeds, and always wipes.
//
// Dev mode (SANDBOX_DEV=1, used by the local driver on macOS): no uid checks,
// no nftables, no service manager — file/socket/key behaviour is real.

import { execFileSync } from "node:child_process";
import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID,
} from "node:crypto";
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const DEV = process.env.SANDBOX_DEV === "1";

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const STATE_DIR = arg("state", "/run/sandbox");
const SOCKET = arg("socket", "/run/sandbox-signer/sign.sock");
const STATE_FILE = join(STATE_DIR, "state.json");
const EVENTS = join(STATE_DIR, "events.jsonl");
const ADAPTER_KEY = join(STATE_DIR, "adapter-key.pem");
const FORWARDER_KEY = join(STATE_DIR, "forwarder-key.pem");
const SINK_TOKEN = join(STATE_DIR, "sink-token.sealed");
const RUN_LOG = join(STATE_DIR, "run.log");

function fail(code, message) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + "\n");
  process.exit(1);
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { sessions: {}, runs: {}, clearedAt: null };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

// clear must survive a corrupt state.json — a half-torn-down sandbox is
// exactly when clear gets called. Unreadable state means "unknown", not "stop".
function loadStateLenient() {
  try {
    return loadState();
  } catch {
    return { sessions: {}, runs: {}, clearedAt: null };
  }
}

// The run-scoped services a VM image manages per run (in the real image:
// systemd units like sandbox-agent-runtime.service, clockchain-adapter.service).
// The spike's ctl records them on the run row at apply time and stops them
// best-effort here — a dead unit is not a failure, missing is success.
function stopRunScopedServices(state) {
  const names = new Set();
  for (const r of Object.values(state.runs ?? {})) {
    for (const n of r.services ?? []) names.add(n);
  }
  for (const name of names) {
    if (DEV) continue; // dev mode has no service manager; names still recorded
    try {
      execFileSync("systemctl", ["stop", name], { stdio: "ignore" });
    } catch {
      try {
        execFileSync("pkill", ["-f", name], { stdio: "ignore" });
      } catch { /* already gone */ }
    }
  }
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
function event(kind, fields) {
  appendFileSync(EVENTS, JSON.stringify({ at: new Date().toISOString(), kind, ...fields }) + "\n");
}
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Minimal signer client over the unix socket (newline JSON).
function signerd(req) {
  return new Promise((resolveP, rejectP) => {
    const conn = connect(SOCKET);
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(JSON.stringify(req) + "\n"));
    conn.on("data", (c) => {
      buf += c;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      conn.end();
      try {
        resolveP(JSON.parse(buf.slice(0, i)));
      } catch (e) {
        rejectP(e);
      }
    });
    conn.on("error", rejectP);
    conn.on("timeout", () => rejectP(new Error("signerd timeout")));
    conn.setTimeout(5000);
  });
}

function ownerReadOnly(path, uid) {
  const st = statSync(path);
  return (st.mode & 0o077) === 0 && (DEV || st.uid === uid);
}

// ctl runs as root (SSM) in the image; run-scoped files that the `svc`
// identity must read are handed over with group ownership.
function handToSvc(path) {
  if (DEV) return;
  execFileSync("chown", ["root:svc", path]);
  chmodSync(path, 0o640);
}

function uidOf(user) {
  return DEV ? 0 : Number(execFileSync("id", ["-u", user], { encoding: "utf8" }).trim());
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const cmd = process.argv.find(
    (a, i) => i > 1 && !a.startsWith("--") && !(process.argv[i - 1] ?? "").startsWith("--"),
  );
  if (!cmd) fail("bad_request", "no command given");
  const jsonArg = process.argv[process.argv.indexOf(cmd) + 1];
  const input = jsonArg && !jsonArg.startsWith("--") ? JSON.parse(jsonArg) : {};
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

  if (cmd === "open-handshake") {
    const side = input.side;
    if (side !== "buyer" && side !== "seller") fail("bad_request", "side must be buyer|seller");
    const state = loadState();
    const sessionId = input.sessionId ?? randomUUID();
    if (state.sessions[sessionId]) fail("conflict", `session ${sessionId} already exists`);
    const openedAt = new Date().toISOString();
    state.sessions[sessionId] = { sessionId, side, state: "open", openedAt };
    saveState(state);
    event("wake", { sessionId, op: "open-handshake" });
    out({ ok: true, sessionId, side, state: "open", openedAt });
    return;
  }

  if (cmd === "list-handshakes") {
    out({ ok: true, sessions: Object.values(loadState().sessions) });
    return;
  }

  if (cmd === "apply-run-config") {
    const { runId, sessionId } = input;
    if (!runId || !sessionId) fail("bad_request", "runId and sessionId required");
    const state = loadState();
    const session = state.sessions[sessionId];
    if (!session) fail("unknown_session", `no handshake session ${sessionId}`);
    if (session.state !== "open") fail("session_closed", `session ${sessionId} is ${session.state}`);
    if (state.runs[runId]?.cleared) fail("run_cleared", `run ${runId} was cleared`);
    if (!state.runs[runId]) {
      // First application mints the run-scoped key material.
      const init = await signerd({ op: "init", sessionId });
      if (!init.ok) fail("signer_error", init.error?.message ?? "signerd init failed");
      const adapter = generateKeyPairSync("ed25519");
      writeFileSync(ADAPTER_KEY, adapter.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      handToSvc(ADAPTER_KEY); // the Clockchain local adapter runs as svc
      if (!existsSync(FORWARDER_KEY)) {
        const fwd = generateKeyPairSync("x25519");
        writeFileSync(FORWARDER_KEY, fwd.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
        handToSvc(FORWARDER_KEY); // the telemetry forwarder runs as svc
      }
      const fwdPub = createPrivateKey(readFileSync(FORWARDER_KEY));
      const fwdPubRaw = createPublicKey(fwdPub).export({ type: "spki", format: "der" });
      state.runs[runId] = {
        runId,
        sessionId,
        agentConfigRevision: input.agentConfigRevision ?? null,
        appliedAt: new Date().toISOString(),
        signerPublicKeyPem: init.publicKeyPem,
        adapterPublicKeyPem: adapter.publicKey.export({ type: "spki", format: "pem" }).toString(),
        forwarderSealingPublicKeyB64: fwdPubRaw.toString("base64"),
        // Run-scoped services `clear` must stop (R4). In the VM image these
        // are systemd units; in the spike no real units exist, but the names
        // are recorded so the wipe path and evidence agree on the contract.
        services: ["sandbox-agent-runtime.service", "clockchain-adapter.service"],
        cleared: false,
      };
      event("run", { runId, op: "apply-run-config" });
      saveState(state);
    }
    const r = state.runs[runId];
    out({
      ok: true,
      runId,
      sessionId: r.sessionId,
      signerPublicKeyPem: r.signerPublicKeyPem,
      adapterPublicKeyPem: r.adapterPublicKeyPem,
      forwarderSealingPublicKeyB64: r.forwarderSealingPublicKeyB64,
    });
    return;
  }

  if (cmd === "install-sink-token") {
    const { runId, sealedTokenB64 } = input;
    if (!runId || !sealedTokenB64) fail("bad_request", "runId and sealedTokenB64 required");
    const state = loadState();
    const run = state.runs[runId];
    if (!run) fail("unknown_run", `run ${runId} was never configured`);
    if (run.cleared) fail("run_cleared", `run ${runId} was cleared`);
    const sealed = Buffer.from(sealedTokenB64, "base64");
    writeFileSync(SINK_TOKEN, sealed, { mode: 0o600 }); // ciphertext only, ever
    handToSvc(SINK_TOKEN);
    event("run", { runId, op: "install-sink-token" });
    out({ ok: true, runId, tokenDigest: sha256(sealed) });
    return;
  }

  if (cmd === "clear") {
    // Always callable, always idempotent, and survivable when half of the
    // state is already gone: stop run-scoped services, forget signer session
    // keys, wipe every byte of run state. A corrupt state.json must NOT stop
    // the wipe — that is exactly the case clear exists for. In the image run
    // state also lives on tmpfs, so a stopped instance is clean anyway.
    const state = loadStateLenient();
    stopRunScopedServices(state);
    for (const s of Object.values(state.sessions)) {
      if (s.state === "open") {
        s.state = "closed";
        await signerd({ op: "clear", sessionId: s.sessionId }).catch(() => {});
      }
    }
    for (const r of Object.values(state.runs)) r.cleared = true;
    state.clearedAt = new Date().toISOString();
    try {
      saveState(state);
    } catch { /* a read-only state dir still wipes below */ }
    for (const f of [ADAPTER_KEY, SINK_TOKEN, RUN_LOG]) rmSync(f, { force: true });
    event("wake", { op: "clear", runId: input.runId ?? null });
    out({ ok: true, clearedAt: state.clearedAt });
    return;
  }

  if (cmd === "gen-evidence") {
    const { runId } = input;
    const state = loadState();
    const run = state.runs[runId];
    if (!run) fail("unknown_run", `no run ${runId}`);
    const events = existsSync(EVENTS)
      ? readFileSync(EVENTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const runEvents = events.filter((e) => e.runId === runId || (e.kind === "wake" && e.sessionId === run.sessionId));
    const startedAt = run.appliedAt;
    const endedAt = run.cleared ? state.clearedAt : new Date().toISOString();
    const logBytes = existsSync(RUN_LOG) ? readFileSync(RUN_LOG) : Buffer.alloc(0);
    const foreign = events.filter(
      (e) => e.at >= startedAt && e.at <= endedAt && !runEvents.includes(e),
    );
    // Pin the ruleset actually in force — the egress spec digest alone only
    // says what SHOULD have been applied (R3 -> R8).
    let egressRulesetSha256 = null;
    if (!DEV) {
      try {
        egressRulesetSha256 = sha256(
          execFileSync("nft", ["list", "table", "inet", "sandbox_egress"], { encoding: "utf8" }),
        );
      } catch { /* no nftables here — null is the honest answer */ }
    }
    out({
      ok: true,
      runId,
      sessionId: run.sessionId,
      agentConfigRevision: run.agentConfigRevision,
      signerPublicKeyPem: run.signerPublicKeyPem,
      window: { start: startedAt, end: endedAt },
      logSha256: sha256(logBytes),
      foreignEvents: foreign.map((e) => ({ at: e.at, kind: e.kind, runId: e.runId ?? null, op: e.op })),
      eventLogSha256: sha256(existsSync(EVENTS) ? readFileSync(EVENTS, "utf8") : Buffer.alloc(0)),
      egressRulesetSha256,
    });
    return;
  }

  if (cmd === "health") {
    // R9: identities, permissions, egress rules, versions, sockets, profiles.
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail ?? null });
    for (const user of ["agent", "signer", "svc"]) {
      check(`user:${user}`, DEV || (() => { try { uidOf(user); return true; } catch { return false; } })());
    }
    const keyFile = arg("key-file", "/etc/sandbox-signer/signing-key.pem");
    check(
      "key-file-perms",
      DEV
        ? existsSync(keyFile) && (statSync(keyFile).mode & 0o077) === 0
        : existsSync(keyFile) && ownerReadOnly(keyFile, uidOf("signer")),
      keyFile,
    );
    check("signer-socket", existsSync(SOCKET), SOCKET);
    try {
      const h = await signerd({ op: "health" });
      check("signerd-answers", h.ok === true);
      check("signer-key-loaded", h.keySource === "file", h.keySource);
    } catch {
      check("signerd-answers", false, "socket unreachable");
    }
    if (!DEV) {
      const sockStat = existsSync(SOCKET) ? statSync(SOCKET) : null;
      check("signer-socket-mode", sockStat && (sockStat.mode & 0o777) === 0o660);
      try {
        const rules = execFileSync("nft", ["list", "table", "inet", "sandbox_egress"], { encoding: "utf8" });
        check("egress-table", /policy drop/.test(rules) && /skuid/.test(rules));
      } catch {
        check("egress-table", false, "nft table sandbox_egress missing");
      }
    } else {
      check("egress-table", true, "dev mode: not applied");
    }
    check("node", /^v(20|22|24)\./.test(process.version), process.version);
    const bad = checks.filter((c) => !c.ok);
    out({ ok: bad.length === 0, devMode: DEV, checks });
    process.exit(bad.length === 0 ? 0 : 1);
  }

  fail("bad_request", `unknown command ${String(cmd)}`);
}

main().catch((err) => fail("internal", String(err?.message ?? err)));
