// MANUAL DEMO DRIVER (not run by CI/tests) — invoke by hand to prove the flow live.
// Turnkey Agent Trust Handshake demo — REAL end-to-end run.
// Embedded Postgres + the LIVE Clockchain gateway (creds from server/.env).
// Drives the two human-approval gates automatically and prints every step.
// Run: npx tsx server/scripts/handshake-demo-run.ts
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { createDb, applyPendingMigrations, ensurePostgresDatabase, agents, companies } from "@paperclipai/db";
import { handshakeDemoService } from "../src/services/handshake-demo.js";
import { approvalService } from "../src/services/approvals.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load server/.env so the REAL clockchain service is used (not disabled).
function loadEnv() {
  const envPath = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(envPath)) { console.log("(!) no server/.env found — clockchain may be disabled"); return; }
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
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

function printSteps(steps: Array<{ title: string; status: string; detail?: string; evidence?: Record<string, unknown> }>) {
  for (const s of steps) {
    const icon = s.status === "done" ? "✅" : s.status === "waiting_approval" ? "⏸️ " : s.status === "blocked" ? "❌" : "…";
    console.log(`  ${icon} [${s.status}] ${s.title}${s.detail ? ` — ${s.detail}` : ""}`);
    if (s.evidence && Object.keys(s.evidence).length) console.log(`       evidence: ${JSON.stringify(s.evidence)}`);
  }
}

async function main() {
  loadEnv();
  console.log(`clockchain: AGENTDASH_ATTESTATION_ENABLED=${process.env.AGENTDASH_ATTESTATION_ENABLED} key=${process.env.CLOCKCHAIN_MCP_KEY ? "set" : "MISSING"} allow_degraded=${process.env.CLOCKCHAIN_ALLOW_DEGRADED}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handshake-demo-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "paperclip", password: "paperclip", port, persistent: false, initdbFlags: ["--encoding=UTF8"] });
  console.log("starting embedded postgres…");
  await pg.initialise();
  await pg.start();
  try {
    const admin = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(admin, "paperclip");
    const conn = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    console.log("applying migrations…");
    await applyPendingMigrations(conn);
    const db = createDb(conn);

    const demo = handshakeDemoService(db);
    const approvals = approvalService(db);

    console.log("\n=== RUNNING TURNKEY HANDSHAKE DEMO (real Clockchain) ===\n");
    let done = false;
    for (let go = 1; go <= 12 && !done; go++) {
      console.log(`--- Go #${go} ---`);
      const { steps, done: d } = await demo.advance();
      printSteps(steps);
      done = d;

      // Auto-resolve the human-approval gates (simulate the two clicks).
      const waiting = steps.find((s) => s.status === "waiting_approval" && (s as any).approvalId);
      if (waiting) {
        const id = (waiting as any).approvalId as string;
        console.log(`  → auto-approving gate "${waiting.title}" (approval ${id})`);
        await approvals.approve(id, "demo-human", "approved by turnkey demo driver");
      } else if (!done) {
        // ready/pending (e.g. anchor settling) — small wait then re-Go.
        await new Promise((r) => setTimeout(r, 1500));
      }
      console.log("");
    }

    // Show the seeded agents + their adapter.
    const co = await db.select().from(companies);
    const ag = await db.select().from(agents);
    console.log("=== SEEDED STATE ===");
    for (const c of co) console.log(`  company: ${c.name} (${c.id})`);
    for (const a of ag) console.log(`  agent:   ${a.name} [adapter=${a.adapterType}] company=${a.companyId}`);
    console.log(`\n=== RESULT: ${done ? "✅ DEMO COMPLETED (transaction attested on-chain)" : "⚠️ did not reach done in 12 Gos"} ===`);
  } finally {
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error("ERR:", e); process.exit(1); });
