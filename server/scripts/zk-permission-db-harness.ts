// CLO-137 DB-layer harness. Exercises the SAME wired path + nullifier dedup + verifier flow as
// zk-permission-mandated-action.test.ts, but starts embedded Postgres directly with generous
// init timeouts so it actually RUNS on hosts where vitest's fixed-60s support probe times out.
// Run: npx tsx server/scripts/zk-permission-db-harness.ts   (from repo root or server/)
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { createDb, applyPendingMigrations, ensurePostgresDatabase, companies, agents, mandates, zkPermissionProofs } from "@paperclipai/db";
import { mandatedActionService } from "../src/services/mandated-action.js";
import { zkPermissionService } from "../src/services/zk-permission.js";

const ACTION = "release_payment";
const ACTOR_DID = "did:clockchain:agentdash:actor01";
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (!a || typeof a === "string") return reject(new Error("no port"));
      const { port } = a;
      s.close(() => resolve(port));
    });
  });
}

function makeClock() {
  const captured: { inputs?: Record<string, unknown> } = {};
  const clock = {
    verifyIdentityAt: async () => ({ status: "valid" as const }),
    attestAction: async (args: { inputs?: Record<string, unknown> }) => {
      captured.inputs = args.inputs;
      const receipt = { eventHash: "eh-1", anchor: { ledgerId: "L1", blockHeight: 4477946 }, status: "anchored" };
      return { attested: true, ledgerId: "L1", blockHeight: 4477946, eventHash: "eh-1", status: "anchored" as const, receipt };
    },
    verifyReceipt: async () => ({ verified: true }),
  };
  return { clock, captured };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zk-harness-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "paperclip", password: "paperclip", port, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"], onLog: () => {}, onError: () => {} });
  console.log("initialising embedded postgres (generous timeout)…");
  await pg.initialise();
  await pg.start();
  try {
    const admin = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(admin, "paperclip");
    const conn = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    console.log("applying migrations (incl. 0095)…");
    await applyPendingMigrations(conn);
    const db = createDb(conn);

    // Seed.
    const [company] = await db.insert(companies).values({ name: "ZK Harness Co" }).returning();
    const [grantor] = await db.insert(agents).values({ companyId: company.id, name: "Grantor" }).returning();
    const [grantee] = await db.insert(agents).values({ companyId: company.id, name: "Grantee" }).returning();
    const [mandate] = await db.insert(mandates).values({ companyId: company.id, grantorAgentId: grantor.id, granteeAgentId: grantee.id, scope: [ACTION], permissionKey: "clockchain:attest", spendCapCents: 100_000, expiresAt: new Date(Date.now() + 86_400_000) }).returning();

    const identity = { resolveAgentDid: async () => ACTOR_DID };
    const mandatesStub = { verifyMandate: async () => ({ status: "authorized" as const, scope: [ACTION], spendCapCents: 100_000 }) };
    const svcWith = (clock: unknown) => mandatedActionService(db, clock as never, identity as never, mandatesStub as never, {} as never, {} as never, zkPermissionService(db));
    const now = new Date("2026-07-18T00:00:00.000Z");
    const input = { companyId: company.id, granteeAgentId: grantee.id, mandateId: mandate.id, counterpartyDid: "did:x:cp", action: ACTION, payload: { amountCents: 100 } };

    // 1) flag ON.
    process.env.AGENTDASH_ZK_PROOF_ENABLED = "true";
    const c1 = makeClock();
    const r1 = await svcWith(c1.clock).performMandatedAction(input, now);
    check("flag ON: authorized", r1.authorized === true);
    check("flag ON: permissionProof.anchored", r1.permissionProof?.anchored === true);
    const ph = r1.permissionProof?.proofHash;
    check("flag ON: proofHash is sha256", !!ph && /^[0-9a-f]{64}$/.test(ph));
    const carried = c1.captured.inputs?.permission_proof as { proof_hash?: string } | undefined;
    check("flag ON: proof_hash bound into attest inputs", carried?.proof_hash === ph);
    const rows1 = await db.select().from(zkPermissionProofs);
    check("flag ON: exactly one proof row persisted", rows1.length === 1 && rows1[0].proofHash === ph);
    check("flag ON: row receiptStatus anchored", rows1[0]?.receiptStatus === "anchored");
    const verdict = await zkPermissionService(db).verifyStoredProof(company.id, ph!, c1.clock as never);
    check("verifier: found", verdict.found === true);
    check("verifier: proofValid (off-chain ZK)", verdict.proofValid === true);
    check("verifier: anchored (verify_receipt)", verdict.anchored === true);

    // 2) replay (same T -> same nullifier).
    const c2 = makeClock();
    const r2 = await svcWith(c2.clock).performMandatedAction(input, now);
    check("replay: authorized", r2.authorized === true);
    check("replay: not re-anchored", r2.permissionProof?.anchored === false);
    check("replay: note replay_rejected", r2.permissionProof?.note === "replay_rejected");
    check("replay: attest carried NO permission_proof", c2.captured.inputs?.permission_proof === undefined);
    const rows2 = await db.select().from(zkPermissionProofs);
    check("replay: still exactly one row (no duplicate)", rows2.length === 1);

    // 3) flag OFF.
    delete process.env.AGENTDASH_ZK_PROOF_ENABLED;
    await db.delete(zkPermissionProofs);
    const c3 = makeClock();
    const r3 = await svcWith(c3.clock).performMandatedAction(input, now);
    check("flag OFF: authorized", r3.authorized === true);
    check("flag OFF: no permissionProof", r3.permissionProof === undefined);
    check("flag OFF: attest carried no permission_proof", c3.captured.inputs?.permission_proof === undefined);
    const rows3 = await db.select().from(zkPermissionProofs);
    check("flag OFF: nothing persisted", rows3.length === 0);
  } finally {
    await pg.stop().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`\n=== HARNESS RESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"} ===`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
