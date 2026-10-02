// AgentDash: spike tests for the per-run lifecycle API (R4). These run the
// REAL in-guest agent (sandbox-ctl.mjs) via LocalVmDriver plus a real signerd
// subprocess — so ordering, idempotency and audit are tested against the same
// code the image ships.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSandboxLifecycleService, LifecycleError } from "../sandbox/lifecycle/service.js";
import { SandboxOpError } from "../sandbox/lifecycle/driver.js";
import { LocalVmDriver } from "../sandbox/lifecycle/local-vm-driver.js";

const CO = "company-test";
const drivers = new Map<string, LocalVmDriver>();
let svc: ReturnType<typeof createSandboxLifecycleService>;

beforeEach(async () => {
  drivers.clear();
  svc = createSandboxLifecycleService({ resolveDriver: (c) => drivers.get(c) ?? null });
});

async function driverFor(companyId = CO): Promise<LocalVmDriver> {
  const d = await LocalVmDriver.boot();
  drivers.set(companyId, d);
  return d;
}

afterEach(async () => {
  for (const d of drivers.values()) await d.dispose();
  drivers.clear();
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
  it("open -> list -> apply -> install -> clear", { timeout: 240_000 }, async () => {
    await driverFor();
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

  it("reports a passing per-sandbox health check (R9)", { timeout: 240_000 }, async () => {
    const driver = await driverFor();
    const health = await driver.health();
    expect(health.ok).toBe(true);
    expect(health.checks.find((c) => c.name === "signerd-answers")?.ok).toBe(true);
    expect(health.checks.find((c) => c.name === "key-file-perms")?.ok).toBe(true);
  });
});

describe("company scoping (R1)", () => {
  it("refuses a company with no registered sandbox, audited, no guest call", { timeout: 240_000 }, async () => {
    await driverFor();
    await expect(
      svc.openHandshake({ companyId: "company-unknown", idempotencyKey: k(), side: "buyer" }),
    ).rejects.toMatchObject({ name: "LifecycleError", code: "unknown_company", status: 404 });
    const rec = svc.auditLog().at(-1);
    expect(rec).toMatchObject({ companyId: "company-unknown", outcome: "error", errorCode: "unknown_company" });
    // and the real company's own VM saw nothing
    expect(await svc.listHandshakeSessions({ companyId: CO })).toEqual({ sessions: [] });
  });

  it("two companies get isolated sandboxes — sessions never cross", { timeout: 240_000 }, async () => {
    await driverFor("co-a");
    await driverFor("co-b");
    const hs = await svc.openHandshake({ companyId: "co-a", idempotencyKey: k(), side: "seller" });
    expect((await svc.listHandshakeSessions({ companyId: "co-a" })).sessions).toHaveLength(1);
    expect((await svc.listHandshakeSessions({ companyId: "co-b" })).sessions).toHaveLength(0);
    // co-b cannot apply config against co-a's session
    await expect(
      svc.applyRunConfig({ companyId: "co-b", idempotencyKey: k(), runId: "r", sessionId: hs.sessionId }),
    ).rejects.toThrow(SandboxOpError);
  });
});

describe("idempotency", () => {
  it("replays an identical retry without re-running the guest op", { timeout: 240_000 }, async () => {
    await driverFor();
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

  it("joins a concurrent same-key call instead of running the guest op twice", { timeout: 240_000 }, async () => {
    await driverFor();
    const key = k();
    const req = { companyId: CO, idempotencyKey: key, side: "buyer" as const };
    const [a, b] = await Promise.all([svc.openHandshake(req), svc.openHandshake(req)]);
    expect(b).toEqual(a);
    const listed = await svc.listHandshakeSessions({ companyId: CO });
    expect(listed.sessions).toHaveLength(1); // exactly ONE guest op ran
  });

  it("conflicts when the same key carries a different body", { timeout: 240_000 }, async () => {
    await driverFor();
    const key = k();
    await svc.openHandshake({ companyId: CO, idempotencyKey: key, side: "buyer" });
    await expect(
      svc.openHandshake({ companyId: CO, idempotencyKey: key, side: "seller" }),
    ).rejects.toMatchObject({ name: "LifecycleError", code: "idempotency_conflict" });
  });

  it("clear is never cached — every call executes and audits", { timeout: 240_000 }, async () => {
    await driverFor();
    const first = await svc.clear({ companyId: CO, idempotencyKey: k(), runId: "never-existed" });
    expect(first.cleared).toBe(true);
    const key = k();
    const a = await svc.clear({ companyId: CO, idempotencyKey: key });
    const b = await svc.clear({ companyId: CO, idempotencyKey: key });
    expect(a.cleared && b.cleared).toBe(true);
    // same key twice -> two real executions, not a replay
    expect(svc.auditLog().filter((r) => r.operation === "clear").map((r) => r.outcome)).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
  });

  it("clear wipes even when state.json is corrupt", { timeout: 240_000 }, async () => {
    const driver = await driverFor();
    await openRun();
    writeFileSync(join(driver.stateDir, "state.json"), "{not json!!");
    const res = await svc.clear({ companyId: CO, idempotencyKey: k() });
    expect(res.cleared).toBe(true);
  });
});

describe("ordering", () => {
  it("applyRunConfig on an unknown session fails", { timeout: 240_000 }, async () => {
    await driverFor();
    await expect(
      svc.applyRunConfig({
        companyId: CO,
        idempotencyKey: k(),
        runId: "r",
        sessionId: "no-such-session",
      }),
    ).rejects.toThrow(SandboxOpError);
  });

  it("installSinkToken before applyRunConfig fails", { timeout: 240_000 }, async () => {
    await driverFor();
    await expect(
      svc.installSinkToken({
        companyId: CO,
        idempotencyKey: k(),
        runId: "never-configured",
        sealedTokenB64: "AAAA",
      }),
    ).rejects.toThrow(/never configured|SandboxOpError/);
  });

  it("a cleared session rejects a new applyRunConfig", { timeout: 240_000 }, async () => {
    await driverFor();
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
  it("rejects a malformed request before any guest call — and audits it", { timeout: 240_000 }, async () => {
    await driverFor();
    await expect(svc.openHandshake({ companyId: CO, side: "middle" })).rejects.toThrow(LifecycleError);
    const log = svc.auditLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      companyId: CO,
      operation: "openHandshake",
      outcome: "error",
      errorCode: "invalid_request",
    });
  });

  it("audits every call with a request hash, never the body", { timeout: 240_000 }, async () => {
    await driverFor();
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

  it("audits errors too", { timeout: 240_000 }, async () => {
    await driverFor();
    await expect(
      svc.applyRunConfig({ companyId: CO, idempotencyKey: k(), runId: "r", sessionId: "nope" }),
    ).rejects.toThrow();
    const rec = svc.auditLog().at(-1);
    expect(rec?.outcome).toBe("error");
    expect(rec?.errorCode).toBe("unknown_session");
  });
});
