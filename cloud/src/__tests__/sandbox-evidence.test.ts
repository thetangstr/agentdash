// AgentDash: the R8 evidence record — generated from the local fake VM's real
// guest event log, validated against the schema, and checked for the
// exclusivity proof (no other run or wake inside the window).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { evidenceDigest, generateRunEvidence, runEvidenceSchema } from "../sandbox/evidence.js";
import { LocalVmDriver } from "../sandbox/lifecycle/local-vm-driver.js";

let driver: LocalVmDriver;
beforeEach(async () => {
  driver = await LocalVmDriver.boot({ imageDigest: "sha256:testimage", environmentId: "localvm:test" });
});
afterEach(async () => {
  await driver.dispose();
});

const INPUT = {
  companyId: "co-1",
  agentConfigRevision: "rev-1",
  agentConfigSha256: createHash("sha256").update("cfg").digest("hex"),
  renderedPromptSha256: createHash("sha256").update("prompt").digest("hex"),
  egressSpecSha256: createHash("sha256").update("egress").digest("hex"),
};

async function configure(runId: string) {
  const hs = await driver.openHandshake({ side: "buyer" });
  await driver.applyRunConfig({ runId, sessionId: hs.sessionId });
  return hs;
}

describe("run evidence (R8)", () => {
  it("produces a schema-valid record with image digest and exclusivity proof", async () => {
    await configure("run-a");
    const ev = await generateRunEvidence(driver, { ...INPUT, runId: "run-a" });
    expect(runEvidenceSchema.parse(ev)).toBeTruthy();
    expect(ev.imageDigest).toBe("sha256:testimage");
    expect(ev.environmentId).toBe("localvm:test");
    expect(ev.run.logSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.exclusivity.foreignRuns).toEqual([]);
    expect(ev.exclusivity.foreignWakes).toEqual([]);
    expect(evidenceDigest(ev)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exclusivity proof lists a foreign run that overlaps the window", async () => {
    await configure("run-a");
    // A second session + run lands INSIDE run-a's window.
    await configure("run-b");
    const ev = await generateRunEvidence(driver, { ...INPUT, runId: "run-a" });
    expect(ev.exclusivity.foreignRuns).toContain("run-b");
    expect(ev.exclusivity.foreignWakes.length).toBeGreaterThan(0);
  });

  it("clear stamps the end of the evidence window", async () => {
    await configure("run-a");
    await driver.clear({ runId: "run-a" });
    const ev = await generateRunEvidence(driver, { ...INPUT, runId: "run-a" });
    expect(Date.parse(ev.run.endedAt)).toBeGreaterThanOrEqual(Date.parse(ev.run.startedAt));
  });
});
