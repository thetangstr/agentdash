#!/usr/bin/env node
/**
 * Offline fail-closed readiness scorecard for the Ross private host.
 *
 * This tool never touches a remote host, never changes SSH trust, Tailscale,
 * launchd, power or service settings, and never reads credentials. It evaluates
 * an explicit evidence bundle assembled from observed receipts. Missing or
 * malformed evidence is "unproven", not "pass": a plist on disk or a loopback
 * health check is not host readiness.
 *
 * Subcommands:
 *   evaluate      Score an evidence bundle (JSON) against every gate.
 *   template      Print an empty evidence bundle listing every required field.
 *   observe-local Passive read-only local facts (disk, FileVault, power, uptime)
 *                 for the operator to fold into an evidence bundle. Observations
 *                 only — this is not trusted host-identity proof.
 *   render-drafts Write an inert install/config/rollback draft bundle (rendered
 *                 by scripts/deploy/agentdash-mac-mini-source-launchd.mjs) into a
 *                 scratch directory. Drafts use placeholder secrets, synthetic
 *                 paths and mode 600; they run nothing and install nothing.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildMacMiniSourceLaunchdPlan,
  mergeSourceEnv,
  renderSourceBackupRunner,
  renderSourceBackupScript,
  renderSourceLaunchdPlist,
  renderSourceReadinessScript,
  renderSourceRollbackScript,
  renderSourceRunbook,
  renderSourceSupervisorScript,
  renderSourceUpdateScript,
} from "../deploy/agentdash-mac-mini-source-launchd.mjs";

export const EVIDENCE_KIND = "ross-private-host-evidence";
export const DRAFT_KIND = "ross-private-host-draft-bundle";
/** Ports already owned by shared/live listeners; a private Ross listener may
 * never collide with them. Deny-list only — these ports are never probed.
 * 3100/4777 shared AgentDash, 443/8443 Funnel/Serve, 3199 local execos
 * instance, 3102/3112 MKThink app + Caddy. Extend with --shared-port. */
export const SHARED_LISTENER_PORTS = [3100, 4777, 443, 8443, 3199, 3102, 3112];
export const DEFAULT_MIN_FREE_BYTES = 32 * 1024 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const SECRETISH_KEY_RE = /(value|content|secret|token|password|privatekey)/i;

function nowIso() {
  return new Date().toISOString();
}

function isObj(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function ipv4Octets(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? octets : null;
}

export function isPrivateBindAddress(value) {
  if (!nonEmptyString(value)) return false;
  const host = value.trim().toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const octets = ipv4Octets(host);
  if (octets) {
    if (octets[0] === 127) return true;
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true; // tailnet CGNAT
    if (octets[0] === 10) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
  }
  return false;
}

export function isLoopbackObservation(value) {
  if (!nonEmptyString(value)) return true;
  const v = value.trim().toLowerCase();
  return v === "loopback" || v === "local" || v === "localhost" || v.startsWith("127.");
}

function check(status, detail, extra = {}) {
  return { status, detail, ...extra };
}

function gate(name, items) {
  const missing = [];
  let failed = null;
  const details = [];
  for (const item of items) {
    if (item.status === "fail") {
      failed = failed ?? item;
      details.push(item.detail);
    } else if (item.status === "unproven") {
      missing.push(item.detail);
    } else {
      details.push(item.detail);
    }
  }
  if (failed) return { name, status: "fail", detail: details.join("; "), missing };
  if (missing.length > 0) return { name, status: "unproven", detail: "missing observed evidence", missing };
  return { name, status: "pass", detail: details.join("; ") };
}

function requireFields(source, fields, prefix = "") {
  return fields.map((field) => {
    const value = isObj(source) ? source[field] : undefined;
    return value === undefined || value === null
      ? check("unproven", `${prefix}${field}`)
      : check("pass", `${prefix}${field}=present`);
  });
}

// --- gate evaluators -------------------------------------------------------

export function evaluateHostIdentity(host) {
  const expected = isObj(host) ? host.expected : undefined;
  const identity = isObj(host) ? host.identity : undefined;
  const items = [];
  items.push(
    nonEmptyString(expected?.hostname)
      ? check("pass", `expected.hostname=${expected.hostname}`)
      : check("unproven", "expected.hostname"),
  );
  items.push(...requireFields(identity, ["observedAt", "via", "hostname"], "identity."));
  if (isObj(identity)) {
    if (nonEmptyString(identity.hostname) && nonEmptyString(expected?.hostname)) {
      items.push(
        identity.hostname === expected.hostname
          ? check("pass", "observed hostname matches the selected host")
          : check("fail", `observed hostname ${identity.hostname} does not match selected ${expected.hostname}`),
      );
    }
    if (identity.trusted === true) {
      items.push(check("pass", "identity.trusted=true"));
    } else if (identity.trusted === false) {
      items.push(check("fail", "identity.trusted=false — host identity was observed but not trusted"));
    } else {
      items.push(check("unproven", "identity.trusted"));
    }
    const strong = ["hardwareUuid", "tailscaleNodeId", "hostKeyFingerprintSha256"].filter((key) =>
      nonEmptyString(identity[key]),
    );
    items.push(
      strong.length > 0
        ? check("pass", `strong identity field(s): ${strong.join(", ")}`)
        : check("unproven", "identity.hardwareUuid|tailscaleNodeId|hostKeyFingerprintSha256"),
    );
  }
  return gate("host_identity", items);
}

export function evaluateDiskHeadroom(disk, minFreeBytes = DEFAULT_MIN_FREE_BYTES) {
  const items = requireFields(disk, ["observedAt", "mount"], "disk.");
  const available = isObj(disk) ? disk.availableBytes : undefined;
  if (typeof available === "number" && Number.isFinite(available)) {
    items.push(
      available >= minFreeBytes
        ? check("pass", `availableBytes=${available} >= ${minFreeBytes}`)
        : check("fail", `availableBytes=${available} below required headroom ${minFreeBytes}`),
    );
  } else {
    items.push(check("unproven", "disk.availableBytes"));
  }
  const capacity = isObj(disk) ? disk.capacityPercent : undefined;
  if (typeof capacity === "number" && Number.isFinite(capacity)) {
    items.push(
      capacity <= 95
        ? check("pass", `capacityPercent=${capacity}`)
        : check("fail", `capacityPercent=${capacity} — volume is effectively full`),
    );
  }
  return gate("disk_headroom", items);
}

export function evaluatePrivateListener(listener, sharedPorts = SHARED_LISTENER_PORTS) {
  const allocated = isObj(listener) ? listener.allocated : undefined;
  const items = requireFields(allocated, ["port", "bind", "allocatedBy"], "listener.allocated.");
  const port = isObj(allocated) ? allocated.port : undefined;
  if (port !== undefined && port !== null && !Number.isInteger(port)) {
    items.push(check("fail", `allocated port ${JSON.stringify(port)} is not an integer`));
  } else if (Number.isInteger(port)) {
    if (port < 1024 || port > 65535) {
      items.push(check("fail", `allocated port ${port} is outside the unprivileged range`));
    }
    if (sharedPorts.includes(port)) {
      items.push(check("fail", `allocated port ${port} collides with a shared/live listener port`));
    }
    const observed = isObj(listener) && Array.isArray(listener.observedListeners) ? listener.observedListeners : [];
    const collision = observed.find((entry) => isObj(entry) && entry.port === port);
    if (collision) {
      items.push(
        check(
          "fail",
          `allocated port ${port} already has an observed listener` +
            (nonEmptyString(collision.process) ? ` (${collision.process})` : ""),
        ),
      );
    }
    if (nonEmptyString(allocated.bind)) {
      items.push(
        isPrivateBindAddress(allocated.bind)
          ? check("pass", `bind=${allocated.bind} is private/loopback`)
          : check("fail", `bind=${allocated.bind} is not a private or loopback address`),
      );
    }
  }
  if (isObj(listener) && listener.funnelExposed === true) {
    items.push(check("fail", "listener is exposed through the public Funnel listener"));
  }
  return gate("private_listener", items);
}

export function evaluateAuthenticatedReachability(reachability) {
  const issuer = isObj(reachability) ? reachability.issuer : undefined;
  const client = isObj(reachability) ? reachability.client : undefined;
  const items = requireFields(issuer, ["observedAt", "url", "observedFrom"], "issuer.");
  if (isObj(issuer)) {
    if (issuer.ok === true) items.push(check("pass", "issuer reachable"));
    else if (issuer.ok === false) items.push(check("fail", "issuer reachability observed and failed"));
    else items.push(check("unproven", "issuer.ok"));
    if (nonEmptyString(issuer.observedFrom)) {
      items.push(
        isLoopbackObservation(issuer.observedFrom)
          ? check("unproven", "issuer reachability observed only from loopback")
          : check("pass", `issuer observed from ${issuer.observedFrom}`),
      );
    }
  }
  items.push(...requireFields(client, ["observedAt", "observedFrom", "status", "deploymentMode", "deploymentExposure"], "client."));
  if (isObj(client)) {
    if (nonEmptyString(client.observedFrom)) {
      items.push(
        isLoopbackObservation(client.observedFrom)
          ? check("unproven", "client health observed only from loopback; a private-network or second-device observation is required")
          : check("pass", `client observed from ${client.observedFrom}`),
      );
    }
    if (nonEmptyString(client.status)) {
      items.push(
        client.status === "ok"
          ? check("pass", "client health status=ok")
          : check("fail", `client health status=${client.status}`),
      );
    }
    if (nonEmptyString(client.deploymentMode)) {
      items.push(
        client.deploymentMode === "authenticated"
          ? check("pass", "deploymentMode=authenticated")
          : check("fail", `deploymentMode=${client.deploymentMode}`),
      );
    }
    if (nonEmptyString(client.deploymentExposure)) {
      items.push(
        client.deploymentExposure === "private"
          ? check("pass", "deploymentExposure=private")
          : check("fail", `deploymentExposure=${client.deploymentExposure}`),
      );
    }
    if (client.authReady === true) items.push(check("pass", "authReady=true"));
    else if (client.authReady === false) items.push(check("fail", "authReady=false"));
    else items.push(check("unproven", "client.authReady"));
    if (nonEmptyString(client.bootstrapStatus)) {
      items.push(
        client.bootstrapStatus === "ready"
          ? check("pass", "bootstrapStatus=ready")
          : check("fail", `bootstrapStatus=${client.bootstrapStatus}`),
      );
    } else {
      items.push(check("unproven", "client.bootstrapStatus"));
    }
  }
  return gate("authenticated_reachability", items);
}

export function evaluateServiceIdentity(serviceIdentity) {
  const envFile = isObj(serviceIdentity) ? serviceIdentity.envFile : undefined;
  const items = requireFields(serviceIdentity, ["label", "runsAs"], "serviceIdentity.");
  items.push(...requireFields(envFile, ["path", "mode"], "envFile."));
  if (isObj(envFile)) {
    if (nonEmptyString(envFile.mode)) {
      items.push(
        envFile.mode === "600"
          ? check("pass", "env file mode=600")
          : check("fail", `env file mode=${envFile.mode} — owner-private 600 required`),
      );
    }
    const leaked = Object.keys(envFile).filter((key) => SECRETISH_KEY_RE.test(key) && key !== "secretsPresent");
    if (leaked.length > 0) {
      items.push(check("fail", `evidence carries secret material fields: ${leaked.join(", ")} — record presence only`));
    }
    const present = envFile.secretsPresent;
    if (Array.isArray(present) && present.some((entry) => nonEmptyString(entry) && entry.includes("="))) {
      items.push(check("fail", "secretsPresent must list names, not KEY=value material"));
    } else if (Array.isArray(present) && present.length > 0 && present.every(nonEmptyString)) {
      items.push(check("pass", `secrets present by name: ${present.join(", ")}`));
    } else {
      items.push(check("unproven", "envFile.secretsPresent"));
    }
  }
  return gate("service_identity", items);
}

export function evaluateFileVaultBoot(boot) {
  const items = requireFields(boot, ["observedAt"], "boot.");
  if (isObj(boot)) {
    if (boot.fileVaultEnabled === true) items.push(check("pass", "fileVaultEnabled=true"));
    else if (boot.fileVaultEnabled === false) items.push(check("fail", "FileVault is off — volume is not protected at boot"));
    else items.push(check("unproven", "boot.fileVaultEnabled"));
    if (boot.volumeMountedAtBoot === true) items.push(check("pass", "volumeMountedAtBoot=true"));
    else if (boot.volumeMountedAtBoot === false) items.push(check("fail", "data volume does not mount at boot"));
    else items.push(check("unproven", "boot.volumeMountedAtBoot"));
  }
  return gate("filevault_volume_at_boot", items);
}

export function evaluateSupervisionColdStart(supervision, coldStart) {
  const items = requireFields(supervision, ["observedAt", "label"], "supervision.");
  if (isObj(supervision)) {
    if (supervision.loaded === true) items.push(check("pass", "launchd service loaded"));
    else if (supervision.loaded === false) items.push(check("fail", "launchd service is not loaded"));
    else items.push(check("unproven", "supervision.loaded"));
    if (supervision.keepAlive === true) items.push(check("pass", "KeepAlive=true"));
    else if (supervision.keepAlive === false) items.push(check("fail", "KeepAlive=false"));
    else items.push(check("unproven", "supervision.keepAlive"));
    if (Number.isInteger(supervision.pid) && supervision.pid > 0) {
      items.push(check("pass", `live supervisor pid=${supervision.pid}`));
    } else {
      items.push(check("unproven", "supervision.pid"));
    }
  }
  if (coldStart === null || coldStart === undefined) {
    items.push(check("unproven", "coldStart — no actual cold-boot observation"));
  } else if (isObj(coldStart)) {
    items.push(...requireFields(coldStart, ["observedAt"], "coldStart."));
    if (coldStart.verified === true) items.push(check("pass", "cold-start verified"));
    else if (coldStart.verified === false) items.push(check("fail", "cold-start observation failed"));
    else items.push(check("unproven", "coldStart.verified"));
  } else {
    items.push(check("fail", "coldStart evidence is malformed"));
  }
  return gate("supervision_coldstart", items);
}

export function evaluateSecondDevice(secondDevice) {
  const items = requireFields(secondDevice, ["observedAt", "deviceId"], "secondDevice.");
  if (isObj(secondDevice)) {
    if (secondDevice.authorizedAccess === true) items.push(check("pass", "authorized access observed"));
    else if (secondDevice.authorizedAccess === false) items.push(check("fail", "second-device authorized access was denied"));
    else items.push(check("unproven", "secondDevice.authorizedAccess"));
    if (secondDevice.publicDenial === true) items.push(check("pass", "public/internet denial observed"));
    else if (secondDevice.publicDenial === false) items.push(check("fail", "public access was NOT denied — exposure observed"));
    else items.push(check("unproven", "secondDevice.publicDenial"));
  }
  return gate("second_device_and_public_denial", items);
}

export function evaluatePinnedArtifact(artifact) {
  const items = [];
  const target = isObj(artifact) ? artifact.targetSha : undefined;
  if (nonEmptyString(target)) {
    items.push(
      FULL_SHA_RE.test(target)
        ? check("pass", `targetSha=${target}`)
        : check("fail", `targetSha=${target} is not an exact 40-hex pin`),
    );
  } else {
    items.push(check("unproven", "artifact.targetSha"));
  }
  const checkout = isObj(artifact) ? artifact.checkoutSha : undefined;
  if (nonEmptyString(checkout)) {
    items.push(
      nonEmptyString(target) && checkout === target
        ? check("pass", "deployed checkout matches the pinned SHA")
        : check("fail", `checkoutSha=${checkout} does not match targetSha=${String(target)}`),
    );
  } else {
    items.push(check("unproven", "artifact.checkoutSha"));
  }
  return gate("pinned_artifact", items);
}

// --- backup receipt loading ------------------------------------------------

function readJsonAt(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function loadAgentdashDbReceipt(agentdashDb, evidenceDir) {
  const items = requireFields(agentdashDb, ["observedAt"], "agentdashDb.");
  if (!isObj(agentdashDb)) return items;
  let receipt = agentdashDb;
  if (nonEmptyString(agentdashDb.receiptPath)) {
    if (!evidenceDir) {
      items.push(check("unproven", "agentdashDb.receiptPath needs --evidence-dir to resolve"));
      return items;
    }
    try {
      receipt = readJsonAt(path.resolve(evidenceDir, agentdashDb.receiptPath));
      items.push(check("pass", `receipt loaded from ${agentdashDb.receiptPath}`));
    } catch (error) {
      items.push(check("unproven", `agentdashDb receipt unreadable: ${error.message}`));
      return items;
    }
  }
  if (nonEmptyString(receipt.engine)) {
    items.push(
      receipt.engine === "pg_dump" || receipt.engine === "javascript"
        ? check("pass", `engine=${receipt.engine}`)
        : check("fail", `unknown backup engine ${receipt.engine}`),
    );
  } else {
    items.push(check("unproven", "agentdashDb.engine"));
  }
  if (nonEmptyString(receipt.sha256) && SHA256_RE.test(receipt.sha256)) {
    items.push(check("pass", "sha256 recorded"));
  } else if (nonEmptyString(receipt.sha256)) {
    items.push(check("fail", "sha256 is not a 64-hex digest"));
  } else {
    items.push(check("unproven", "agentdashDb.sha256"));
  }
  const validatedBy = receipt.validatedBy ?? receipt.validation?.method;
  items.push(
    nonEmptyString(validatedBy)
      ? check("pass", `validatedBy=${validatedBy}`)
      : check("unproven", "agentdashDb.validatedBy"),
  );
  return items;
}

function loadRossPrivateReceipt(rossPrivate, evidenceDir) {
  const items = requireFields(rossPrivate, ["observedAt"], "rossPrivate.");
  if (!isObj(rossPrivate)) return items;
  const digest = rossPrivate.manifestSha256 ?? rossPrivate.archiveSha256;
  if (nonEmptyString(digest) && SHA256_RE.test(digest)) {
    items.push(check("pass", "archive/manifest sha256 recorded"));
  } else if (nonEmptyString(digest)) {
    items.push(check("fail", "ross private digest is not a 64-hex sha256"));
  } else {
    items.push(check("unproven", "rossPrivate.manifestSha256|archiveSha256"));
  }
  if (rossPrivate.restoredToScratch === true) {
    items.push(check("pass", "restored to a scratch target"));
  } else if (rossPrivate.restoredToScratch === false) {
    items.push(check("fail", "restore rehearsal did not run to a scratch target"));
  } else {
    items.push(check("unproven", "rossPrivate.restoredToScratch"));
  }
  if (nonEmptyString(rossPrivate.manifestPath)) {
    if (!evidenceDir) {
      items.push(check("unproven", "rossPrivate.manifestPath needs --evidence-dir to resolve"));
    } else {
      try {
        const manifest = readJsonAt(path.resolve(evidenceDir, rossPrivate.manifestPath));
        if (manifest.kind === "ross-private-state-backup" && manifest.schemaVersion === 1) {
          items.push(check("pass", `manifest kind verified at ${rossPrivate.manifestPath}`));
        } else {
          items.push(check("fail", `manifest at ${rossPrivate.manifestPath} is not a ross-private-state-backup`));
        }
      } catch (error) {
        items.push(check("unproven", `rossPrivate manifest unreadable: ${error.message}`));
      }
    }
  }
  return items;
}

export function evaluateBackupSeparation(backups, evidenceDir) {
  const agentdashDb = isObj(backups) ? backups.agentdashDb : undefined;
  const rossPrivate = isObj(backups) ? backups.rossPrivate : undefined;
  const items = [...loadAgentdashDbReceipt(agentdashDb, evidenceDir), ...loadRossPrivateReceipt(rossPrivate, evidenceDir)];
  const dbPath = agentdashDb?.receiptPath ?? agentdashDb?.backupPath;
  const rossPath = rossPrivate?.manifestPath ?? rossPrivate?.archivePath;
  if (nonEmptyString(dbPath) && nonEmptyString(rossPath) && dbPath === rossPath) {
    items.push(check("fail", "AgentDash DB backup and Ross private backup reference the same artifact — backups must be separate"));
  }
  return gate("backup_separation", items);
}

// --- scorecard --------------------------------------------------------------

export function evaluateEvidenceBundle(bundle, options = {}) {
  if (!isObj(bundle) || bundle.kind !== EVIDENCE_KIND || bundle.version !== 1) {
    return {
      ok: false,
      generatedAt: nowIso(),
      summary: { pass: 0, fail: 0, unproven: 1 },
      gates: [
        {
          name: "evidence_bundle",
          status: "fail",
          detail: `expected a ${EVIDENCE_KIND} v1 bundle`,
          missing: [],
        },
      ],
    };
  }
  const gates = [
    evaluateHostIdentity(bundle.host),
    evaluateDiskHeadroom(bundle.disk, options.minFreeBytes),
    evaluatePrivateListener(bundle.listener, options.sharedPorts ?? SHARED_LISTENER_PORTS),
    evaluateAuthenticatedReachability(bundle.reachability),
    evaluateServiceIdentity(bundle.serviceIdentity),
    evaluateFileVaultBoot(bundle.boot),
    evaluateSupervisionColdStart(bundle.supervision, bundle.coldStart),
    evaluateSecondDevice(bundle.secondDevice),
    evaluatePinnedArtifact(bundle.artifact),
    evaluateBackupSeparation(bundle.backups, options.evidenceDir),
  ];
  const summary = gates.reduce(
    (acc, item) => {
      acc[item.status] += 1;
      return acc;
    },
    { pass: 0, fail: 0, unproven: 0 },
  );
  return {
    ok: gates.every((item) => item.status === "pass"),
    generatedAt: nowIso(),
    summary,
    gates,
    remainingEvidence: gates
      .filter((item) => item.status !== "pass")
      .map((item) => ({ gate: item.name, status: item.status, missing: item.missing ?? [] })),
  };
}

// --- evidence template ------------------------------------------------------

export function buildEvidenceTemplate() {
  return {
    version: 1,
    kind: EVIDENCE_KIND,
    collectedAt: null,
    host: {
      expected: { hostname: null },
      identity: {
        observedAt: null,
        via: null,
        hostname: null,
        trusted: null,
        hardwareUuid: null,
        tailscaleNodeId: null,
        hostKeyFingerprintSha256: null,
      },
    },
    disk: { observedAt: null, mount: null, availableBytes: null, capacityPercent: null },
    listener: {
      allocated: { port: null, bind: null, allocatedBy: null, allocatedAt: null },
      observedListeners: [],
      funnelExposed: null,
    },
    reachability: {
      issuer: { observedAt: null, url: null, ok: null, observedFrom: null },
      client: {
        observedAt: null,
        observedFrom: null,
        status: null,
        deploymentMode: null,
        deploymentExposure: null,
        authReady: null,
        bootstrapStatus: null,
      },
    },
    serviceIdentity: {
      label: null,
      runsAs: null,
      envFile: { path: null, mode: null, secretsPresent: [] },
    },
    boot: { observedAt: null, fileVaultEnabled: null, volumeMountedAtBoot: null },
    supervision: { observedAt: null, label: null, loaded: null, pid: null, keepAlive: null },
    coldStart: null,
    secondDevice: { observedAt: null, deviceId: null, authorizedAccess: null, publicDenial: null },
    artifact: { targetSha: null, checkoutSha: null },
    backups: {
      agentdashDb: { observedAt: null, engine: null, sha256: null, validatedBy: null, receiptPath: null },
      rossPrivate: { observedAt: null, manifestSha256: null, restoredToScratch: null, manifestPath: null },
    },
  };
}

// --- passive local observation ----------------------------------------------

function runReadOnly(command, args, timeoutMs = 10000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs });
  return {
    exit: result.status,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
}

export function parseDfOutput(stdout) {
  const lines = String(stdout).split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return null;
  const header = lines[0].toLowerCase();
  // POSIX df -kP: Filesystem blocks used available capacity mounted-on.
  // macOS df -kP adds inode columns: ... capacity iused ifree %iused mounted-on.
  const mountIndex = header.includes("iused") ? 8 : 5;
  const last = lines[lines.length - 1];
  const fields = last.trim().split(/\s+/);
  if (fields.length <= mountIndex) return null;
  const available = Number(fields[3]);
  const capacity = Number(String(fields[4]).replace(/%$/, ""));
  if (!Number.isFinite(available) || !Number.isFinite(capacity)) return null;
  return {
    mount: fields.slice(mountIndex).join(" "),
    availableBytes: available * 1024,
    capacityPercent: capacity,
  };
}

export function parseFileVaultStatus(stdout) {
  const text = String(stdout).toLowerCase();
  if (text.includes("filevault is on")) return true;
  if (text.includes("filevault is off")) return false;
  return null;
}

export function observeLocalHost(observePath = process.cwd()) {
  const df = runReadOnly("df", ["-kP", observePath]);
  const fdesetup = runReadOnly("/usr/bin/fdesetup", ["status"]);
  const pmset = runReadOnly("/usr/bin/pmset", ["-g"]);
  const uptime = runReadOnly("/usr/bin/uptime", []);
  const swVers = runReadOnly("/usr/bin/sw_vers", []);
  const disk = df.exit === 0 ? parseDfOutput(df.stdout) : null;
  return {
    kind: "ross-local-observation",
    observedAt: nowIso(),
    scope: "passive read-only local observations; not trusted host-identity proof and no remote access",
    hostname: os.hostname(),
    swVers: swVers.exit === 0 ? swVers.stdout : null,
    disk: disk ? { ...disk, observedAt: nowIso() } : null,
    fileVaultEnabled: fdesetup.exit === 0 ? parseFileVaultStatus(fdesetup.stdout) : null,
    power: pmset.exit === 0 ? pmset.stdout : null,
    uptime: uptime.exit === 0 ? uptime.stdout : null,
    effects: "read-only; no configuration, service, network, or boot setting changed",
  };
}

// --- inert draft bundle -----------------------------------------------------

const DRAFT_SECRET_PLACEHOLDER = "REPLACE_ON_HOST_generate_mode600_secret";

export function renderDraftBundle(input = {}) {
  if (!nonEmptyString(input.paperclipPort)) {
    throw new Error("render-drafts requires an explicitly allocated --paperclip-port (the default 3100 is a shared listener port and is deny-listed)");
  }
  const port = Number(input.paperclipPort);
  const extraShared = (Array.isArray(input.sharedPorts) ? input.sharedPorts : []).map(Number);
  if (extraShared.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error("--shared-port values must be integers 1-65535");
  }
  const deniedPorts = [...SHARED_LISTENER_PORTS, ...extraShared];
  if (deniedPorts.includes(port)) {
    throw new Error(`--paperclip-port ${port} is a deny-listed shared listener port; allocate a noncolliding private port`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`--paperclip-port must be an integer 1024-65535; got ${input.paperclipPort}`);
  }
  // The drafts describe a direct private listener, so the URL clients use must
  // land on that same allocated port and never on a shared listener.
  let publicUrl;
  try { publicUrl = new URL(String(input.publicUrl)); } catch { throw new Error("--public-url must be an absolute http(s) URL"); }
  if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") throw new Error("--public-url must be an absolute http(s) URL");
  const urlPort = Number(publicUrl.port || (publicUrl.protocol === "https:" ? 443 : 80));
  if (deniedPorts.includes(urlPort)) {
    throw new Error(`--public-url port ${urlPort} is a deny-listed shared listener port; use the allocated private port`);
  }
  if (urlPort !== port) {
    throw new Error(`--public-url port ${urlPort} must match --paperclip-port ${port}`);
  }
  const plan = buildMacMiniSourceLaunchdPlan({
    ...input,
    betterAuthSecret: input.betterAuthSecret ?? DRAFT_SECRET_PLACEHOLDER,
    agentJwtSecret: input.agentJwtSecret ?? DRAFT_SECRET_PLACEHOLDER,
  });
  const artifacts = {
    "agentdash.env.draft": mergeSourceEnv("", plan),
    "agentdash-source-supervisor.sh.draft": renderSourceSupervisorScript(plan),
    "agentdash-backup-db.sh.draft": renderSourceBackupScript(plan),
    "agentdash-backup-db.mjs.draft": renderSourceBackupRunner(plan),
    "agentdash-readiness.sh.draft": renderSourceReadinessScript(plan),
    "agentdash-source-update.sh.draft": renderSourceUpdateScript(plan),
    "agentdash-source-rollback.sh.draft": renderSourceRollbackScript(plan),
    [`${plan.label}.plist.draft`]: renderSourceLaunchdPlist(plan),
    "RUNBOOK.md.draft": renderSourceRunbook(plan),
  };
  return { plan, artifacts };
}

export function writeDraftBundle(input = {}) {
  const outDir = input.outDir;
  if (!nonEmptyString(outDir)) throw new Error("--out-dir is required for render-drafts");
  const resolved = path.resolve(process.cwd(), outDir);
  // Drafts are scratch output: never write them into this checkout, where they
  // could be committed. Compare real paths so symlinks cannot slip inside.
  const repoRoot = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
  let existing = resolved;
  while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  const realTarget = path.join(realpathSync(existing), path.relative(existing, resolved));
  const inside = path.relative(repoRoot, realTarget);
  if (inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside))) {
    throw new Error("--out-dir must be outside the repository checkout");
  }
  const { plan, artifacts } = renderDraftBundle(input);
  mkdirSync(resolved, { recursive: true });
  const manifest = {
    version: 1,
    kind: DRAFT_KIND,
    generatedAt: nowIso(),
    targetSha: plan.targetSha,
    publicUrl: plan.env.PAPERCLIP_PUBLIC_URL,
    label: plan.label,
    inert: true,
    secrets: "placeholder only — no generated or live secret material is present",
    layout: "production Mac minis use the OTA release layout (scripts/deploy/ota-apply.mjs, releases/current); this source-launchd draft bundle is the source-checkout fallback for review",
    effects: "drafts are mode-600 review artifacts; nothing is installed, loaded, or executed",
    planPaths: plan.paths,
    artifacts: [],
  };
  const written = [];
  for (const [name, content] of Object.entries(artifacts)) {
    const target = path.join(resolved, name);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (existsSync(target)) {
      const existing = readFileSync(target);
      const existingSha = createHash("sha256").update(existing).digest("hex");
      if (existingSha !== sha256) {
        throw new Error(`draft target already exists with different content: ${target} — refusing to overwrite`);
      }
      written.push({ name, sha256, bytes: existing.length, status: "unchanged" });
    } else {
      writeFileSync(target, content, { mode: 0o600 });
      chmodSync(target, 0o600);
      written.push({ name, sha256, bytes: Buffer.byteLength(content), status: "written" });
    }
    manifest.artifacts.push({ name, sha256, bytes: Buffer.byteLength(content) });
  }
  const manifestPath = path.join(resolved, "draft-manifest.json");
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existsSync(manifestPath)) {
    const existingSha = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
    const nextSha = createHash("sha256").update(manifestContent).digest("hex");
    if (existingSha !== nextSha) {
      // generatedAt legitimately differs between runs; compare artifact sets instead
      const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
      const sameArtifacts =
        JSON.stringify(existing.artifacts) === JSON.stringify(manifest.artifacts) &&
        existing.targetSha === manifest.targetSha &&
        existing.publicUrl === manifest.publicUrl;
      if (!sameArtifacts) {
        throw new Error(`draft manifest at ${manifestPath} describes a different bundle — refusing to overwrite`);
      }
    }
  } else {
    writeFileSync(manifestPath, manifestContent, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);
  }
  return { outDir: resolved, label: plan.label, targetSha: plan.targetSha, artifacts: written };
}

// --- CLI --------------------------------------------------------------------

function printScorecard(result) {
  for (const item of result.gates) {
    console.log(`${item.status.toUpperCase()}\t${item.name}\t${item.detail}`);
    for (const missing of item.missing ?? []) {
      console.log(`  missing: ${missing}`);
    }
  }
  console.log(
    `Summary: ${result.summary.pass} pass, ${result.summary.unproven} unproven, ${result.summary.fail} fail — ` +
      (result.ok ? "READY" : "NOT READY (missing evidence is unproven, never inferred)"),
  );
}

function printHelp() {
  console.log(`Usage:
  node scripts/ross/host-readiness.mjs evaluate --evidence <bundle.json> [options]
  node scripts/ross/host-readiness.mjs template
  node scripts/ross/host-readiness.mjs observe-local [--path <dir>]
  node scripts/ross/host-readiness.mjs render-drafts --target-sha <40hex> --public-url <url> --out-dir <dir> [options]

evaluate options:
  --evidence <file>        Evidence bundle JSON (kind ${EVIDENCE_KIND}).
  --evidence-dir <dir>     Directory used to resolve receiptPath/manifestPath references.
  --min-free-bytes <n>     Required free disk bytes (default ${DEFAULT_MIN_FREE_BYTES}).
  --shared-port <port>     Additional shared/live listener port to refuse (repeatable).
  --json                   Print the JSON scorecard.

render-drafts options:
  --target-sha <sha>       Exact 40-hex reviewed git SHA (required).
  --public-url <url>       Private/tailnet URL the deployed instance will answer on (required).
  --out-dir <dir>          Scratch directory for the inert draft bundle, outside the repository (required).
  --label <label>          launchd label (default ai.agentdash.agent).
  --paperclip-port <port>  Explicitly allocated private listener port (required;
                           no default — 3100 is a deny-listed shared listener).
  --repo-dir/--agentdash-home/--config-dir/--launch-agent-dir/--paperclip-home/--log-dir/--backup-dir/--state-dir/--runtime-env-file
                           Synthetic target paths rendered into the drafts; nothing is created there.
  --json                   Print the JSON write summary.

Production Mac minis use the OTA release layout (scripts/deploy/ota-apply.mjs,
releases/current); render-drafts produces the source-checkout fallback for
review. This tool performs no remote access, no trust changes and no service,
boot or power mutations. Missing evidence is always "unproven", never "pass".
`);
}

function sharedPortsFrom(values) {
  const extra = values["shared-port"] ?? [];
  const ports = [...SHARED_LISTENER_PORTS];
  for (const value of Array.isArray(extra) ? extra : [extra]) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`--shared-port must be an integer 1-65535; got ${value}`);
    }
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      evidence: { type: "string" },
      "evidence-dir": { type: "string" },
      "min-free-bytes": { type: "string" },
      "shared-port": { type: "string", multiple: true },
      "target-sha": { type: "string" },
      "public-url": { type: "string" },
      "out-dir": { type: "string" },
      label: { type: "string" },
      "paperclip-port": { type: "string" },
      "repo-dir": { type: "string" },
      "agentdash-home": { type: "string" },
      "config-dir": { type: "string" },
      "launch-agent-dir": { type: "string" },
      "paperclip-home": { type: "string" },
      "log-dir": { type: "string" },
      "backup-dir": { type: "string" },
      "state-dir": { type: "string" },
      "runtime-env-file": { type: "string" },
      path: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || !command) {
    printHelp();
    return;
  }

  if (command === "template") {
    console.log(JSON.stringify(buildEvidenceTemplate(), null, 2));
    return;
  }

  if (command === "observe-local") {
    console.log(JSON.stringify(observeLocalHost(values.path ?? process.cwd()), null, 2));
    return;
  }

  if (command === "render-drafts") {
    const summary = writeDraftBundle({
      outDir: values["out-dir"],
      targetSha: values["target-sha"],
      publicUrl: values["public-url"],
      label: values.label,
      paperclipPort: values["paperclip-port"],
      sharedPorts: values["shared-port"],
      repoDir: values["repo-dir"],
      agentdashHome: values["agentdash-home"],
      configDir: values["config-dir"],
      launchAgentDir: values["launch-agent-dir"],
      paperclipHome: values["paperclip-home"],
      logDir: values["log-dir"],
      backupDir: values["backup-dir"],
      stateDir: values["state-dir"],
      envFile: values["runtime-env-file"],
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (command === "evaluate") {
    if (!values.evidence) throw new Error("evaluate requires --evidence <bundle.json>");
    const bundle = readJsonAt(values.evidence);
    const result = evaluateEvidenceBundle(bundle, {
      evidenceDir: values["evidence-dir"] ? path.resolve(process.cwd(), values["evidence-dir"]) : undefined,
      minFreeBytes: values["min-free-bytes"] ? Number(values["min-free-bytes"]) : undefined,
      sharedPorts: sharedPortsFrom(values),
    });
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printScorecard(result);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`unknown subcommand: ${command}`);
}

const invokedDirectly = (() => {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[host-readiness] ${error.message}`);
    process.exitCode = 1;
  });
}
