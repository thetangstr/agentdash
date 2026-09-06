// Client-initiated OTA: the read-only status surface and the approval ceremony.
//
// There is deliberately NO apply route here. The server records that a human
// approved a specific release; a separate privileged process observes that
// record and acts. Two reasons, and both are load-bearing:
//
//   1. A process cannot reliably restart itself and then report on how the
//      restart went. The thing that applies an update has to outlive it.
//   2. Putting deploy authority in the web tier makes every web vulnerability a
//      remote-code-execution path on a customer's machine. The blast radius of
//      this endpoint should be "wrote a JSON file saying someone said yes".
//
// The approval is written to the same deployments directory the updater already
// owns, rather than to the database, so the updater stays standalone. That
// matters here more than usual: the updater is the tool that repairs a bad
// deploy, and a repair tool that needs the application's database to be healthy
// is not a repair tool.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { type OtaApproval } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { assertBoardOrgAccess } from "./authz.js";
import {
  APPROVAL_FILENAME,
  defaultOtaStateDir,
  getOtaUpdateStatus,
} from "../services/ota-status.js";
import { listAppliedMigrationIds } from "../services/ota-migrations.js";

/**
 * Approving a release is an instance-level act, not a company-level one: it
 * changes the code every company on this instance runs.
 */
function assertCanApproveUpdates(req: Request) {
  if (req.actor.type !== "board") throw forbidden("Board access required");
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  throw forbidden("Instance admin access required");
}

function approvalPath(stateDir: string): string {
  return path.join(stateDir, APPROVAL_FILENAME);
}

function readApproval(stateDir: string): OtaApproval | null {
  const target = approvalPath(stateDir);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, "utf8")) as OtaApproval;
  } catch {
    return null;
  }
}

function writeApproval(stateDir: string, approval: OtaApproval): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(approvalPath(stateDir), `${JSON.stringify(approval, null, 2)}\n`, { mode: 0o600 });
}

export function otaRoutes(db: Db, options: { stateDir?: string } = {}) {
  const router = Router();
  const stateDir = options.stateDir ?? defaultOtaStateDir();

  async function currentStatus() {
    return getOtaUpdateStatus({
      stateDir,
      appliedMigrationIds: await listAppliedMigrationIds(db),
      runningReleaseDir: process.env.AGENTDASH_RELEASE_DIR ?? null,
    });
  }

  /**
   * Everything the board needs to render the Update panel. Read-only: it writes
   * nothing and triggers nothing, so it is safe to poll.
   */
  router.get("/instance/ota/status", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await currentStatus());
  });

  /**
   * Record that a human wants this exact release.
   *
   * The candidate is re-read from the status rather than trusted from the body:
   * the client tells us WHICH release it means, and the server decides whether
   * that is the release actually on offer. Accepting a tag/commit pair from the
   * request would let a stale or hostile client approve something that was
   * never presented for review.
   */
  router.post("/instance/ota/approvals", async (req, res) => {
    assertCanApproveUpdates(req);
    const status = await currentStatus();

    if (!status.available) throw badRequest("There is no available release to approve.");

    const tag = typeof req.body?.tag === "string" ? req.body.tag : null;
    const commit = typeof req.body?.commit === "string" ? req.body.commit : null;
    if (!tag || !commit) throw badRequest("Both 'tag' and 'commit' are required.");
    if (tag !== status.available.tag || commit !== status.available.commit) {
      throw conflict(
        "The release you approved is not the release currently on offer. Reload and review the current release.",
        { offered: { tag: status.available.tag, commit: status.available.commit } },
      );
    }

    const existing = readApproval(stateDir);
    if (existing && existing.status === "approved" && existing.commit === commit) {
      throw conflict("This release is already approved.", { approvalId: existing.id });
    }

    const approval: OtaApproval = {
      id: randomUUID(),
      tag: status.available.tag,
      commit: status.available.commit,
      channel: status.available.channel,
      status: "pending",
      requestedByUserId: req.actor.userId ?? "",
      requestedAt: new Date().toISOString(),
      decidedByUserId: null,
      decidedAt: null,
      approvedVerdict: null,
    };
    writeApproval(stateDir, approval);
    res.status(201).json({ approval });
  });

  /**
   * Approve or reject.
   *
   * The compatibility verdict at decision time is stamped onto the record. That
   * is what lets the updater detect drift later: if a migration appears between
   * approval and apply, the stored verdict no longer matches and the apply is
   * refused rather than proceeding on a consent that was given for a different
   * set of facts.
   */
  router.post("/instance/ota/approvals/:approvalId/decision", async (req, res) => {
    assertCanApproveUpdates(req);
    const approvalId = req.params.approvalId as string;
    const approval = readApproval(stateDir);
    if (!approval || approval.id !== approvalId) throw notFound("No such approval.");
    if (approval.status !== "pending") {
      throw conflict(`Approval is already '${approval.status}'.`);
    }

    const decision = req.body?.decision;
    if (decision !== "approved" && decision !== "rejected") {
      throw badRequest("'decision' must be 'approved' or 'rejected'.");
    }

    const status = await currentStatus();
    if (decision === "approved" && status.compatibility.verdict === "unknown") {
      throw conflict(
        "Compatibility with the database could not be determined, so this release cannot be approved. Resolve the migration inventory first.",
      );
    }
    if (decision === "approved" && approval.commit !== status.available?.commit) {
      throw conflict("The offered release changed since this approval was requested. Request a new one.");
    }

    const decided: OtaApproval = {
      ...approval,
      status: decision,
      decidedByUserId: req.actor.userId ?? "",
      decidedAt: new Date().toISOString(),
      approvedVerdict: decision === "approved" ? status.compatibility.verdict : null,
    };
    writeApproval(stateDir, decided);
    res.json({ approval: decided });
  });

  /** Withdraw an approval. Cheap to do, and the safe direction. */
  router.delete("/instance/ota/approvals/:approvalId", async (req, res) => {
    assertCanApproveUpdates(req);
    const approval = readApproval(stateDir);
    if (!approval || approval.id !== req.params.approvalId) throw notFound("No such approval.");
    unlinkSync(approvalPath(stateDir));
    res.json({ withdrawn: true, approvalId: approval.id });
  });

  return router;
}
