import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildEvidenceTemplate,
  evaluateEvidenceBundle,
  evaluateHostIdentity,
  evaluatePrivateListener,
  isLoopbackObservation,
  isPrivateBindAddress,
  observeLocalHost,
  parseDfOutput,
  parseFileVaultStatus,
  renderDraftBundle,
  writeDraftBundle,
} from "./host-readiness.mjs";

const SCRIPT = fileURLToPath(new URL("./host-readiness.mjs", import.meta.url));
const TARGET_SHA = "2eb0e488192fd193a59020ce93e72993b985862a";
const OTHER_SHA = "bb306b91b728bf6b26c7a213ed2a4da7781f2650";
const DIGEST = createHash("sha256").update("x").digest("hex");

function completeEvidence() {
  return {
    version: 1,
    kind: "ross-private-host-evidence",
    collectedAt: "2026-09-30T12:00:00Z",
    host: {
      expected: { hostname: "ross-host-example" },
      identity: {
        observedAt: "2026-09-30T11:00:00Z",
        via: "verified ssh host key fingerprint over known-good channel",
        hostname: "ross-host-example",
        trusted: true,
        hardwareUuid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        tailscaleNodeId: "nXYZ123",
      },
    },
    disk: { observedAt: "2026-09-30T11:00:00Z", mount: "/", availableBytes: 200 * 1024 * 1024 * 1024, capacityPercent: 40 },
    listener: {
      allocated: { port: 3114, bind: "100.64.0.14", allocatedBy: "operator-ticket-ROSS-6" },
      observedListeners: [{ port: 3100, bind: "127.0.0.1", process: "existing-agentdash" }],
      funnelExposed: false,
    },
    reachability: {
      issuer: { observedAt: "2026-09-30T11:05:00Z", url: "http://100.64.0.14:3114/api/auth", ok: true, observedFrom: "tailnet:operator-laptop" },
      client: {
        observedAt: "2026-09-30T11:05:00Z",
        observedFrom: "tailnet:operator-laptop",
        status: "ok",
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authReady: true,
        bootstrapStatus: "ready",
      },
    },
    serviceIdentity: {
      label: "ai.agentdash.ross",
      runsAs: "rosssvc",
      envFile: { path: "/Users/rosssvc/.config/agentdash/ross.env", mode: "600", secretsPresent: ["BETTER_AUTH_SECRET", "PAPERCLIP_AGENT_JWT_SECRET"] },
    },
    boot: { observedAt: "2026-09-30T11:00:00Z", fileVaultEnabled: true, volumeMountedAtBoot: true },
    supervision: { observedAt: "2026-09-30T11:06:00Z", label: "ai.agentdash.ross", loaded: true, pid: 4242, keepAlive: true },
    coldStart: { observedAt: "2026-09-30T11:20:00Z", verified: true },
    secondDevice: { observedAt: "2026-09-30T11:30:00Z", deviceId: "operator-ipad-tailnet", authorizedAccess: true, publicDenial: true },
    artifact: { targetSha: TARGET_SHA, checkoutSha: TARGET_SHA },
    backups: {
      agentdashDb: { observedAt: "2026-09-30T11:40:00Z", engine: "javascript", sha256: DIGEST, validatedBy: "throwaway-database-restore" },
      rossPrivate: { observedAt: "2026-09-30T11:45:00Z", manifestSha256: DIGEST, restoredToScratch: true },
    },
  };
}

function gateByName(result, name) {
  return result.gates.find((item) => item.name === name);
}

test("a complete observed evidence bundle evaluates ready", () => {
  const result = evaluateEvidenceBundle(completeEvidence());
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { pass: 10, fail: 0, unproven: 0 });
});

test("an empty template fails closed with every gate unproven", () => {
  const result = evaluateEvidenceBundle(buildEvidenceTemplate());
  assert.equal(result.ok, false);
  assert.equal(result.summary.pass, 0);
  assert.equal(result.summary.fail, 0);
  assert.ok(result.summary.unproven >= 10);
  for (const gate of result.gates) assert.equal(gate.status, "unproven");
});

test("a malformed bundle is refused", () => {
  const result = evaluateEvidenceBundle({ kind: "not-a-bundle" });
  assert.equal(result.ok, false);
  assert.equal(gateByName(result, "evidence_bundle").status, "fail");
});

test("untrusted or mismatched host identity fails", () => {
  const evidence = completeEvidence();
  evidence.host.identity.trusted = false;
  const result = evaluateEvidenceBundle(evidence);
  assert.equal(gateByName(result, "host_identity").status, "fail");

  const mismatch = completeEvidence();
  mismatch.host.identity.hostname = "mac-studio-shared";
  const gate = evaluateHostIdentity(mismatch.host);
  assert.equal(gate.status, "fail");

  const noStrongField = completeEvidence();
  delete noStrongField.host.identity.hardwareUuid;
  delete noStrongField.host.identity.tailscaleNodeId;
  assert.equal(evaluateHostIdentity(noStrongField.host).status, "unproven");
});

test("a nearly full disk fails the headroom gate", () => {
  const evidence = completeEvidence();
  evidence.disk = { observedAt: "2026-09-30T11:00:00Z", mount: "/Volumes/data", availableBytes: 13 * 1024 * 1024 * 1024, capacityPercent: 98 };
  const result = evaluateEvidenceBundle(evidence);
  assert.equal(result.ok, false);
  assert.equal(gateByName(result, "disk_headroom").status, "fail");
});

test("shared-listener and wildcard binds fail; missing allocation stays unproven", () => {
  const shared = evaluatePrivateListener({
    allocated: { port: 3100, bind: "127.0.0.1", allocatedBy: "op" },
    observedListeners: [],
  });
  assert.equal(shared.status, "fail");

  const wildcard = evaluatePrivateListener({
    allocated: { port: 3114, bind: "0.0.0.0", allocatedBy: "op" },
    observedListeners: [],
  });
  assert.equal(wildcard.status, "fail");

  const collision = evaluatePrivateListener({
    allocated: { port: 3114, bind: "100.64.0.14", allocatedBy: "op" },
    observedListeners: [{ port: 3114, bind: "0.0.0.0", process: "other" }],
  });
  assert.equal(collision.status, "fail");

  const funnel = evaluatePrivateListener({
    allocated: { port: 3114, bind: "100.64.0.14", allocatedBy: "op" },
    observedListeners: [],
    funnelExposed: true,
  });
  assert.equal(funnel.status, "fail");

  for (const shared of [3199, 3102, 3112]) {
    const denied = evaluatePrivateListener({
      allocated: { port: shared, bind: "100.64.0.14", allocatedBy: "op" },
      observedListeners: [],
    });
    assert.equal(denied.status, "fail", `deny-listed shared port ${shared} must fail`);
  }

  const missing = evaluatePrivateListener({ allocated: { bind: "100.64.0.14" } });
  assert.equal(missing.status, "unproven");

  const malformedPort = evaluatePrivateListener({
    allocated: { port: "3114", bind: "100.64.0.14", allocatedBy: "op" },
  });
  assert.equal(malformedPort.status, "fail");
});

test("loopback-only health does not prove private reachability", () => {
  const evidence = completeEvidence();
  evidence.reachability.client.observedFrom = "loopback";
  const result = evaluateEvidenceBundle(evidence);
  assert.equal(gateByName(result, "authenticated_reachability").status, "unproven");

  const publicExposure = completeEvidence();
  publicExposure.reachability.client.deploymentExposure = "public";
  assert.equal(
    gateByName(evaluateEvidenceBundle(publicExposure), "authenticated_reachability").status,
    "fail",
  );
});

test("secret material in evidence fails service identity", () => {
  const evidence = completeEvidence();
  evidence.serviceIdentity.envFile.secretsPresent = ["BETTER_AUTH_SECRET=abc123"];
  assert.equal(gateByName(evaluateEvidenceBundle(evidence), "service_identity").status, "fail");

  const leaked = completeEvidence();
  leaked.serviceIdentity.envFile.values = { BETTER_AUTH_SECRET: "x" };
  assert.equal(gateByName(evaluateEvidenceBundle(leaked), "service_identity").status, "fail");

  const worldReadable = completeEvidence();
  worldReadable.serviceIdentity.envFile.mode = "644";
  assert.equal(gateByName(evaluateEvidenceBundle(worldReadable), "service_identity").status, "fail");
});

test("missing cold-start keeps supervision unproven; FileVault off fails", () => {
  const evidence = completeEvidence();
  evidence.coldStart = null;
  assert.equal(gateByName(evaluateEvidenceBundle(evidence), "supervision_coldstart").status, "unproven");

  const vaultOff = completeEvidence();
  vaultOff.boot.fileVaultEnabled = false;
  assert.equal(gateByName(evaluateEvidenceBundle(vaultOff), "filevault_volume_at_boot").status, "fail");
});

test("second-device gate requires both authorization and public denial", () => {
  const evidence = completeEvidence();
  delete evidence.secondDevice.publicDenial;
  assert.equal(gateByName(evaluateEvidenceBundle(evidence), "second_device_and_public_denial").status, "unproven");

  const exposed = completeEvidence();
  exposed.secondDevice.publicDenial = false;
  assert.equal(gateByName(evaluateEvidenceBundle(exposed), "second_device_and_public_denial").status, "fail");
});

test("artifact pin requires an exact 40-hex match with the deployed checkout", () => {
  const evidence = completeEvidence();
  evidence.artifact.checkoutSha = OTHER_SHA;
  assert.equal(gateByName(evaluateEvidenceBundle(evidence), "pinned_artifact").status, "fail");

  const shortPin = completeEvidence();
  shortPin.artifact.targetSha = TARGET_SHA.slice(0, 7);
  shortPin.artifact.checkoutSha = TARGET_SHA.slice(0, 7);
  const gate = gateByName(evaluateEvidenceBundle(shortPin), "pinned_artifact");
  assert.equal(gate.status, "fail");
});

test("backup separation requires two distinct validated backups", () => {
  const missingDb = completeEvidence();
  delete missingDb.backups.agentdashDb;
  assert.equal(gateByName(evaluateEvidenceBundle(missingDb), "backup_separation").status, "unproven");

  const samePath = completeEvidence();
  samePath.backups.agentdashDb.receiptPath = "same.json";
  samePath.backups.rossPrivate.manifestPath = "same.json";
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "host-readiness-evidence-"));
  writeFileSync(path.join(evidenceDir, "same.json"), JSON.stringify({}), "utf8");
  const result = evaluateEvidenceBundle(samePath, { evidenceDir });
  assert.equal(gateByName(result, "backup_separation").status, "fail");

  const referenced = completeEvidence();
  referenced.backups.agentdashDb = { observedAt: "2026-09-30T11:40:00Z", receiptPath: "db.receipt.json" };
  writeFileSync(
    path.join(evidenceDir, "db.receipt.json"),
    JSON.stringify({ engine: "pg_dump", sha256: DIGEST, sizeBytes: 4096, validation: { method: "pg_restore --list" } }),
    { encoding: "utf8", mode: 0o600 },
  );
  referenced.backups.rossPrivate = { observedAt: "2026-09-30T11:45:00Z", manifestSha256: DIGEST, restoredToScratch: true, manifestPath: "ross-manifest.json" };
  writeFileSync(
    path.join(evidenceDir, "ross-manifest.json"),
    JSON.stringify({ schemaVersion: 1, kind: "ross-private-state-backup", scope: { companyId: "c", projectId: "p", agentId: "a" } }),
    { encoding: "utf8", mode: 0o600 },
  );
  const resolved = evaluateEvidenceBundle(referenced, { evidenceDir });
  assert.equal(gateByName(resolved, "backup_separation").status, "pass");

  const wrongKind = completeEvidence();
  wrongKind.backups.rossPrivate = { observedAt: "2026-09-30T11:45:00Z", manifestSha256: DIGEST, restoredToScratch: true, manifestPath: "wrong.json" };
  writeFileSync(path.join(evidenceDir, "wrong.json"), JSON.stringify({ kind: "something-else" }), "utf8");
  assert.equal(gateByName(evaluateEvidenceBundle(wrongKind, { evidenceDir }), "backup_separation").status, "fail");
});

test("private bind detection and loopback observation helpers", () => {
  assert.equal(isPrivateBindAddress("127.0.0.1"), true);
  assert.equal(isPrivateBindAddress("100.64.0.14"), true);
  assert.equal(isPrivateBindAddress("192.168.1.10"), true);
  assert.equal(isPrivateBindAddress("0.0.0.0"), false);
  assert.equal(isPrivateBindAddress("203.0.113.10"), false);
  assert.equal(isLoopbackObservation("loopback"), true);
  assert.equal(isLoopbackObservation("tailnet:ipad"), false);
});

test("observe-local collects passive facts without effects", () => {
  const observation = observeLocalHost(process.cwd());
  assert.equal(observation.kind, "ross-local-observation");
  assert.ok(observation.hostname.length > 0);
  assert.ok(observation.disk === null || typeof observation.disk.availableBytes === "number");
  assert.match(observation.effects, /read-only/);
});

test("df and FileVault parsers handle real macOS shapes", () => {
  const parsed = parseDfOutput(
    "Filesystem   1024-blocks      Used Available Capacity  iused     ifree %iused  Mounted on\n" +
      "/dev/disk7s1   468646704 454680548  13810892    98% 10014223 138108920    7%   /Volumes/data",
  );
  assert.equal(parsed.mount, "/Volumes/data");
  assert.equal(parsed.availableBytes, 13810892 * 1024);
  assert.equal(parsed.capacityPercent, 98);
  assert.equal(parseFileVaultStatus("FileVault is On."), true);
  assert.equal(parseFileVaultStatus("FileVault is Off."), false);
});

test("render-drafts writes inert mode-600 artifacts with placeholder secrets", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ross-host-drafts-"));
  const summary = writeDraftBundle({
    outDir,
    targetSha: TARGET_SHA,
    publicUrl: "http://100.64.0.14:3114",
    label: "ai.agentdash.ross",
    paperclipPort: "3114",
    repoDir: "/scratch/ross-private/repo",
    agentdashHome: "/scratch/ross-private/home",
  });
  assert.equal(summary.artifacts.length, 9);

  const envDraft = readFileSync(path.join(outDir, "agentdash.env.draft"), "utf8");
  assert.match(envDraft, /REPLACE_ON_HOST_generate_mode600_secret/);
  assert.doesNotMatch(envDraft, /BETTER_AUTH_SECRET=[0-9a-f]{64}/);
  assert.match(envDraft, /AGENTDASH_SOURCE_SHA=2eb0e488192fd193a59020ce93e72993b985862a/);
  assert.match(envDraft, /PAPERCLIP_DEPLOYMENT_EXPOSURE=private/);

  const plist = readFileSync(path.join(outDir, "ai.agentdash.ross.plist.draft"), "utf8");
  assert.match(plist, /<string>ai\.agentdash\.ross<\/string>/);

  const supervisor = readFileSync(path.join(outDir, "agentdash-source-supervisor.sh.draft"), "utf8");
  assert.match(supervisor, /REPO_DIR="\/scratch\/ross-private\/repo"/);
  assert.match(supervisor, /EXPECTED_SHA=/);

  for (const artifact of summary.artifacts) {
    assert.equal(statSync(path.join(outDir, artifact.name)).mode & 0o777, 0o600);
    assert.equal(artifact.sha256, createHash("sha256").update(readFileSync(path.join(outDir, artifact.name))).digest("hex"));
  }
});

test("render-drafts is idempotent and refuses silent overwrites", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ross-host-drafts-"));
  const input = { outDir, targetSha: TARGET_SHA, publicUrl: "http://100.64.0.14:3114", paperclipPort: "3114" };
  const first = writeDraftBundle(input);
  const second = writeDraftBundle(input);
  assert.deepEqual(
    second.artifacts.map((a) => a.status),
    first.artifacts.map(() => "unchanged"),
  );

  writeFileSync(path.join(outDir, "agentdash.env.draft"), "corrupted", "utf8");
  assert.throws(() => writeDraftBundle(input), /refusing to overwrite/);
});

test("render-drafts requires an exact pinned sha", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ross-host-drafts-"));
  assert.throws(
    () => writeDraftBundle({ outDir, targetSha: "latest", publicUrl: "http://100.64.0.14:3114", paperclipPort: "3114" }),
    /pinned/,
  );
});

test("render-drafts requires an explicitly allocated port and records the OTA layout note", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ross-host-drafts-"));
  assert.throws(
    () => writeDraftBundle({ outDir, targetSha: TARGET_SHA, publicUrl: "http://100.64.0.14:3114" }),
    /--paperclip-port/,
  );
  writeDraftBundle({ outDir, targetSha: TARGET_SHA, publicUrl: "http://100.64.0.14:3114", paperclipPort: "3114" });
  const manifest = JSON.parse(readFileSync(path.join(outDir, "draft-manifest.json"), "utf8"));
  assert.match(manifest.layout, /OTA release layout/);
  assert.match(manifest.layout, /ota-apply\.mjs/);
});

test("render-drafts rejects deny-listed shared ports like evaluate does", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ross-host-drafts-"));
  for (const port of ["3100", "3199", "3102", "3112", "443", "8443", "4777"]) {
    assert.throws(
      () => writeDraftBundle({ outDir, targetSha: TARGET_SHA, publicUrl: `http://100.64.0.14:${port}`, paperclipPort: port }),
      new RegExp(`deny-listed`),
      `port ${port} must be refused`,
    );
  }
  assert.throws(
    () => writeDraftBundle({ outDir, targetSha: TARGET_SHA, publicUrl: "http://100.64.0.14:9999", paperclipPort: "9999", sharedPorts: ["9999"] }),
    /deny-listed/,
  );
  assert.throws(
    () => writeDraftBundle({ outDir, targetSha: TARGET_SHA, publicUrl: "http://100.64.0.14:3114", paperclipPort: "abc" }),
    /integer/,
  );
});

test("render-drafts refuses an out-dir inside the repository checkout", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  for (const outDir of [repoRoot, path.join(repoRoot, "scripts/ross/drafts-should-not-exist")]) {
    assert.throws(
      () => writeDraftBundle({ outDir, targetSha: TARGET_SHA, publicUrl: "http://100.64.0.14:3114", paperclipPort: "3114" }),
      /outside the repository/,
    );
  }
  assert.equal(existsSync(path.join(repoRoot, "scripts/ross/drafts-should-not-exist")), false);
});

test("render-drafts checks the public URL port against the deny-list and the allocated port", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ross-host-drafts-"));
  for (const url of ["http://100.64.0.14:3100", "http://100.64.0.14:3199", "https://mini.example.ts.net"]) {
    assert.throws(
      () => writeDraftBundle({ outDir, targetSha: TARGET_SHA, publicUrl: url, paperclipPort: "3114" }),
      /deny-listed/,
      `${url} must be refused`,
    );
  }
  assert.throws(
    () => writeDraftBundle({ outDir, targetSha: TARGET_SHA, publicUrl: "http://100.64.0.14:3115", paperclipPort: "3114" }),
    /must match --paperclip-port/,
  );
});

test("evaluate CLI exits nonzero on incomplete evidence and prints the scorecard", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "host-readiness-cli-"));
  const bundle = buildEvidenceTemplate();
  bundle.host.expected.hostname = "ross-host-example";
  const file = path.join(dir, "evidence.json");
  writeFileSync(file, JSON.stringify(bundle), "utf8");
  let stdout = "";
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [SCRIPT, "evaluate", "--evidence", file], { encoding: "utf8" });
  } catch (error) {
    code = error.status;
    stdout = String(error.stdout);
  }
  assert.equal(code, 1);
  assert.match(stdout, /UNPROVEN/);
  assert.match(stdout, /NOT READY/);
});

test("evaluate CLI exits zero on a complete bundle", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "host-readiness-cli-"));
  const file = path.join(dir, "evidence.json");
  writeFileSync(file, JSON.stringify(completeEvidence()), "utf8");
  const stdout = execFileSync(process.execPath, [SCRIPT, "evaluate", "--evidence", file, "--json"], { encoding: "utf8" });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
});

test("template subcommand prints the evidence skeleton", () => {
  const stdout = execFileSync(process.execPath, [SCRIPT, "template"], { encoding: "utf8" });
  const bundle = JSON.parse(stdout);
  assert.equal(bundle.kind, "ross-private-host-evidence");
  assert.equal(bundle.host.expected.hostname, null);
});
