// MANUAL DEMO DRIVER (not run by CI/tests) — invoke by hand to prove the flow live.
// Turnkey Agent Trust Handshake — REAL, AGENT-DRIVEN end-to-end run.
// Each decision is made by a real Hermes agent (real inference via the hermes_local
// adapter) reading its own role AGENTS.md; each accepted decision is wired to the
// LIVE Clockchain gateway. Real embedded Postgres for state.
//   npx tsx server/scripts/handshake-demo-agentdriven.mts
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { createDb, applyPendingMigrations, ensurePostgresDatabase, agents, companies, mandates, zkPermissionProofs } from "@paperclipai/db";
import { desc } from "drizzle-orm";
import { handshakeAgentRunner } from "../src/services/handshake-agent-runner.js";
import { clockchainService } from "../src/services/clockchain.js";
import { agentIdentityService } from "../src/services/agent-identity.js";
import { mandatesService } from "../src/services/mandates.js";
import { mandatedActionService } from "../src/services/mandated-action.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const p = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); if (!a || typeof a === "string") return reject(new Error("no port")); const { port } = a; s.close(() => resolve(port)); });
  });
}

// Run one real Hermes agent decision via the shared, product handshake-agent-runner
// service (same code path the product uses under AGENTDASH_HANDSHAKE_AGENT_DRIVEN).
// It provisions the agent's profile, writes its role AGENTS.md, invokes the REAL
// adapter, and returns the verbatim decision line + reasoning.
const agentRunner = handshakeAgentRunner();
async function runAgentDecision(input: {
  agentId: string; name: string; companyId: string; role: string; agentsMd: string; task: string;
}): Promise<{ decision: string; approved: boolean; raw: string }> {
  const r = await agentRunner.runDecision(input);
  return { decision: r.decision, approved: r.approved, raw: r.raw };
}

function reasoningTail(raw: string): string {
  // The human-readable reasoning block, trimmed for display.
  const idx = raw.indexOf("Reasoning");
  const chunk = idx >= 0 ? raw.slice(idx) : raw;
  return chunk.replace(/\[hermes\][^\n]*\n/g, "").replace(/session_id:.*$/ms, "").trim().slice(0, 700);
}

async function main() {
  loadEnv();
  // Turn ON the ZK permission-proof path so Iris's release generates a real
  // Semaphore v4 proof ("I hold this permission, without revealing the credential"),
  // anchors its hash via attest_action, and stores it for display below.
  process.env.AGENTDASH_ZK_PROOF_ENABLED = "true";
  console.log(`clockchain: enabled=${process.env.AGENTDASH_ATTESTATION_ENABLED} key=${process.env.CLOCKCHAIN_MCP_KEY ? "set" : "MISSING"} degraded=${process.env.CLOCKCHAIN_ALLOW_DEGRADED} zk=${process.env.AGENTDASH_ZK_PROOF_ENABLED}\n`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handshake-ad-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "paperclip", password: "paperclip", port, persistent: false, initdbFlags: ["--encoding=UTF8"] });
  await pg.initialise(); await pg.start();
  try {
    const admin = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(admin, "paperclip");
    const conn = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(conn);
    const db = createDb(conn);
    const clock = clockchainService();
    const identity = agentIdentityService(db, clock);
    const mandatesSvc = mandatesService(db, clock, identity);
    const actions = mandatedActionService(db, clock, identity, mandatesSvc);

    // Real DB seed: two companies + three hermes_local agents.
    const [payer] = await db.insert(companies).values({ name: "Meridian Pay", issuePrefix: "MER" }).returning();
    const [payee] = await db.insert(companies).values({ name: "Trellis Freight", issuePrefix: "TRE" }).returning();
    const [atlas] = await db.insert(agents).values({ companyId: payer.id, name: "Atlas", role: "ceo", adapterType: "hermes_local" }).returning();
    const [iris] = await db.insert(agents).values({ companyId: payer.id, name: "Iris", role: "payments", adapterType: "hermes_local" }).returning();
    const [billie] = await db.insert(agents).values({ companyId: payee.id, name: "Billie", role: "payments", adapterType: "hermes_local" }).returning();
    console.log("seeded: Meridian Pay {Atlas ceo, Iris payments} · Trellis Freight {Billie payments} — all adapter=hermes_local\n");

    const CAP = 1000;
    console.log("=== STEP 1 — Atlas (Meridian CEO) decides whether to grant Iris a payment mandate ===");
    const a = await runAgentDecision({
      agentId: atlas.id, name: "Atlas", companyId: payer.id, role: "ceo",
      agentsMd: `You are Atlas, CEO of Meridian Pay. You authorize your agents by granting scoped, capped, time-bound mandates that are anchored on Clockchain. You grant only what the business needs and never more.`,
      task: `Iris, your payments agent, needs to pay vendor Trellis Freight up to $${CAP} over the next week for freight services.\n` +
        `Decide whether to grant Iris a mandate: scope=release_payment, spend cap $${CAP}, expires in 7 days.\n` +
        `Reply with EXACTLY one line: "APPROVE: <why>" or "DECLINE: <why>".`,
    });
    console.log("Atlas reasoning:\n  " + reasoningTail(a.raw).replace(/\n/g, "\n  "));
    console.log("Atlas decision: " + a.decision + "\n");
    if (!a.approved) { console.log("Atlas declined — handshake stops."); return; }

    // Real Clockchain: grant + anchor + publish the mandate.
    let mandate = await mandatesSvc.createMandate({
      companyId: payer.id, grantorAgentId: atlas.id, granteeAgentId: iris.id,
      scope: ["release_payment"], permissionKey: "clockchain:attest", spendCapCents: CAP * 100,
      expiresAt: new Date(Date.now() + 7 * 86400000),
    });
    console.log(`→ mandate anchored: ledgerId=${mandate.ccLedgerId} block=${mandate.ccBlockHeight}`);
    mandate = await mandatesSvc.publishMandate(payer.id, mandate.id, payee.id);
    console.log(`→ published to Trellis Freight\n`);

    console.log("=== STEP 2 — Billie (Trellis payments agent) decides whether to accept the mandate ===");
    const b = await runAgentDecision({
      agentId: billie.id, name: "Billie", companyId: payee.id, role: "payments",
      agentsMd: `You are Billie, the payments agent at Trellis Freight. You review incoming payment mandates from counterparties before agreeing to transact. You accept a mandate only if its scope and cap are reasonable for the business relationship.`,
      task: `Meridian Pay published a payment mandate naming Trellis Freight as the counterparty: scope=release_payment, spend cap $${CAP}, valid 7 days. Meridian is a freight customer.\n` +
        `Decide whether to accept this mandate and clear to transact.\n` +
        `Reply with EXACTLY one line: "ACCEPT: <why>" or "REJECT: <why>".`,
    });
    console.log("Billie reasoning:\n  " + reasoningTail(b.raw).replace(/\n/g, "\n  "));
    console.log("Billie decision: " + b.decision + "\n");
    if (!b.approved) { console.log("Billie rejected — handshake stops."); return; }
    mandate = await mandatesSvc.acceptMandate(payee.id, mandate.id);
    console.log(`→ mandate accepted at ${mandate.acceptedAt}\n`);

    console.log("=== STEP 3 — Iris (Meridian payments agent) decides whether to release the payment ===");
    const i = await runAgentDecision({
      agentId: iris.id, name: "Iris", companyId: payer.id, role: "payments",
      agentsMd: `You are Iris, the payments agent at Meridian Pay. You operate strictly under mandates granted by your CEO. Every payment you release is anchored on Clockchain. You act only within your mandate's scope and cap.`,
      task: `You hold an accepted mandate: scope=release_payment, cap $${CAP}, counterparty Trellis Freight (cleared to transact). A $100.00 freight invoice from Trellis is due now — within scope and cap.\n` +
        `Decide whether to release this $100.00 payment.\n` +
        `Reply with EXACTLY one line: "APPROVE: <why>" or "DECLINE: <why>".`,
    });
    console.log("Iris reasoning:\n  " + reasoningTail(i.raw).replace(/\n/g, "\n  "));
    console.log("Iris decision: " + i.decision + "\n");
    if (!i.approved) { console.log("Iris declined — no payment attested."); return; }

    // Real Clockchain: KYA the counterparty + attest the mandated action → receipt.
    const result = await actions.runDemoAttestation({ companyId: payer.id, mandateId: mandate.id, action: "release_payment" });
    console.log("=== TRANSACTION ATTESTED ON-CHAIN ===");
    console.log(`  authorized: ${result.authorized}`);
    console.log(`  ledgerId:   ${result.ledgerId}`);
    console.log(`  blockHeight:${result.blockHeight}`);
    console.log(`  eventHash:  ${result.eventHash}`);

    // Surface the ZK permission proof Iris generated as part of the attestation.
    const [proof] = await db.select().from(zkPermissionProofs).orderBy(desc(zkPermissionProofs.createdAt)).limit(1);
    if (proof) {
      console.log("\n=== ZK PERMISSION PROOF (prove-permission-without-revealing-the-credential) ===");
      console.log(`  scheme:        ${proof.scheme}`);
      console.log(`  scope:         ${proof.scope} (valid-at ${proof.validAt})`);
      console.log(`  authority root:${proof.authority}`);
      console.log(`  nullifier:     ${proof.nullifier}   (UNIQUE — double-use detectable)`);
      console.log(`  proof_hash:    ${proof.proofHash}   (the 32-byte digest anchored on-chain)`);
      console.log(`  anchor status: ${proof.receiptStatus}`);
      console.log(`  → the credential itself is never sent; only this hash rides the attest_action anchor.`);
    } else {
      console.log("\n(⚠️  no ZK permission proof row found — check AGENTDASH_ZK_PROOF_ENABLED)");
    }
    console.log(`\n=== RESULT: ${result.authorized ? "✅ COMPLETED — 3 real agent decisions + real ZK permission proof + real on-chain receipt" : "❌ denied: " + (result as any).reason} ===`);
  } finally {
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error("ERR:", e); process.exit(1); });
