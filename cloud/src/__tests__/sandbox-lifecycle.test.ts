// AgentDash: spike tests for the per-run lifecycle API (R4). These run the
// REAL in-guest agent (sandbox-ctl.mjs) via LocalVmDriver plus a real signerd
// subprocess — so ordering, idempotency and audit are tested against the same
// code the image ships.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSandboxLifecycleService, LifecycleError } from "../sandbox/lifecycle/service.js";
import { SandboxOpError } from "../sandbox/lifecycle/driver.js";
import { LocalVmDriver } from "../sandbox/lifecycle/local-vm-driver.js";

const CO = "company-test";
let driver: LocalVmDriver;
let svc: ReturnType<typeof createSandboxLifecycleService>;

beforeEach(async () => {
  driver = await LocalVmDriver.boot();
  svc = createSandboxLifecycleService({ driver });
});
afterEach(async () => {
  await driver.dispose();
});

const k = () => `idem-${randomUUID()}`;

async function openRun() {
  const hs = await svc.openHandshake({ companyId: CO, idempotencyKey: k(), side: "buyer" });
  const cfg = await svc.applyRunConfig({
    companyId: CO,
    idempotencyKey: k(),
    runId: "run-1",
    sessionId: hs.sessionId,
    agentConfigRevision: "rev-42",
  });
  return { hs, cfg };
}

describe("lifecycle happy path", () => {
  it("open -> list -> apply -> install -> clear", async () => {
    const { hs, cfg } = await openRun();
    expect(hs.state).toBe("open");
    expect(cfg.signerPublicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(cfg.forwarderSealingPublicKeyB64.length).toBeGreaterThan(20);

    const listed = await svc.listHandshakeSessions({ companyId: CO });
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ sessionId: hs.sessionId, side: "buyer" });

    const tok = await svc.installSinkToken({
      companyId: CO,
      idempotencyKey: k(),
      runId: "run-1",
      sealedTokenB64: Buffer.from("sealed-ciphertext").toString("base64"),
    });
    expect(tok.installed).toBe(true);

    const cleared = await svc.clear({ companyId: CO, idempotencyKey: k(), runId: "run-1" });
    expect(cleared.cleared).toBe(true);
  });

  it("reports a passing per-sandbox health check (R9)", async () => {
    const health = await driver.health();
    expect(health.ok).toBe(true);
    expect(health.checks.find((c) => c.name === "signerd-answers")?.ok).toBe(true);
    expect(health.checks.find((c) => c.name === "key-file-perms")?.ok).toBe(true);
  });
});

describe("idempotency", () => {
  it("replays an identical retry without re-running the guest op", async () => {
    const key = k();
    const a = await svc.openHandshake({ companyId: CO, idempotencyKey: key, side: "buyer" });
    const b = await svc.openHandshake({ companyId: CO, idempotencyKey: key, side: "buyer" });
    expect(b).toEqual(a);
    const listed = await svc.listHandshakeSessions({ companyId: CO });
    expect(listed.sessions).toHaveLength(1); // no duplicate session
    expect(svc.auditLog().filter((r) => r.operation === "openHandshake").map((r) => r.outcome)).toEqual([
      "ok",
      "replayed",
    ]);
  });

  it("conflicts when the same key carries a different body", async () => {
    const key = k();
    await svc.openHandshake({ companyId: CO, idempotencyKey: key, side: "buyer" });
    await expect(
      svc.openHandshake({ companyId: CO, idempotencyKey: key, side: "seller" }),
    ).rejects.toMatchObject({ name: "LifecycleError", code: "idempotency_conflict" });
  });

  it("clear is idempotent and always callable", async () => {
    const first = await svc.clear({ companyId: CO, idempotencyKey: k(), runId: "never-existed" });
    expect(first.cleared).toBe(true);
    const key = k();
    const a = await svc.clear({ companyId: CO, idempotencyKey: key });
    const b = await svc.clear({ companyId: CO, idempotencyKey: key });
    expect(b).toEqual(a);
  });
});

describe("ordering", () => {
  it("applyRunConfig on an unknown session fails", async () => {
    await expect(
      svc.applyRunConfig({
        companyId: CO,
        idempotencyKey: k(),
        runId: "r",
        sessionId: "no-such-session",
      }),
    ).rejects.toThrow(SandboxOpError);
  });

  it("installSinkToken before applyRunConfig fails", async () => {
    await expect(
      svc.installSinkToken({
        companyId: CO,
        idempotencyKey: k(),
        runId: "never-configured",
        sealedTokenB64: "AAAA",
      }),
    ).rejects.toThrow(/never configured|SandboxOpError/);
  });

  it("a cleared session rejects a new applyRunConfig", async () => {
    const { hs } = await openRun();
    await svc.clear({ companyId: CO, idempotencyKey: k(), runId: "run-1" });
    await expect(
      svc.applyRunConfig({
        companyId: CO,
        idempotencyKey: k(),
        runId: "run-2",
        sessionId: hs.sessionId,
      }),
    ).rejects.toThrow(SandboxOpError);
  });
});

describe("schema + audit", () => {
  it("rejects a malformed request before any guest call", async () => {
    await expect(svc.openHandshake({ companyId: CO, side: "middle" })).rejects.toThrow(LifecycleError);
    expect(svc.auditLog()).toHaveLength(0);
  });

  it("audits every call with a request hash, never the body", async () => {
    const sealed = Buffer.from("SEALED-SECRET-CIPHERTEXT").toString("base64");
    await openRun();
    await svc.installSinkToken({ companyId: CO, idempotencyKey: k(), runId: "run-1", sealedTokenB64: sealed });
    const log = svc.auditLog();
    expect(log.length).toBe(3);
    for (const rec of log) {
      expect(rec.requestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.companyId).toBe(CO);
      expect(JSON.stringify(rec)).not.toContain("SEALED-SECRET");
    }
    expect(log.map((r) => r.operation)).toEqual(["openHandshake", "applyRunConfig", "installSinkToken"]);
  });

  it("audits errors too", async () => {
    await expect(
      svc.applyRunConfig({ companyId: CO, idempotencyKey: k(), runId: "r", sessionId: "nope" }),
    ).rejects.toThrow();
    const rec = svc.auditLog().at(-1);
    expect(rec?.outcome).toBe("error");
    expect(rec?.errorCode).toBe("unknown_session");
  });
});
