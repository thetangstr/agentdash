// Verify the PRODUCT handshake-demo contract: run the real advance() loop (agent-driven
// + ZK on) wrapped in the Clockchain call recorder, auto-resolving the two approval gates,
// and dump the exact JSON shape the /api/handshake-demo/go route returns (steps + ZK + clockchainCalls).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { createDb, applyPendingMigrations, ensurePostgresDatabase } from "@paperclipai/db";
import { handshakeDemoService } from "../src/services/handshake-demo.js";
import { approvalService } from "../src/services/approvals.js";
import { withClockchainCallRecorder, type ClockchainCall } from "../src/services/clockchain.js";

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

async function main() {
  loadEnv();
  process.env.AGENTDASH_HANDSHAKE_AGENT_DRIVEN = "true";
  process.env.AGENTDASH_ZK_PROOF_ENABLED = "true";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-contract-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "paperclip", password: "paperclip", port, persistent: false, initdbFlags: ["--encoding=UTF8"] });
  await pg.initialise(); await pg.start();
  try {
    const admin = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(admin, "paperclip");
    const conn = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(conn);
    const db = createDb(conn);
    const demo = handshakeDemoService(db);
    const approvals = approvalService(db);

    const allCalls: ClockchainCall[] = [];
    let done = false;
    let last: any = null;
    for (let go = 1; go <= 12 && !done; go++) {
      const calls: ClockchainCall[] = [];
      const result = await withClockchainCallRecorder((c) => calls.push(c), () => demo.advance());
      last = { ...result, clockchainCalls: calls };
      allCalls.push(...calls);
      done = result.done;
      const waiting = result.steps.find((s: any) => s.status === "waiting_approval" && s.approvalId);
      if (waiting) await approvals.approve((waiting as any).approvalId, "demo-human", "demo");
      else if (!done) await new Promise((r) => setTimeout(r, 1000));
    }
    // Dump the final /go response shape + a summary of all Clockchain calls.
    console.log("=== FINAL /go RESPONSE (last advance) ===");
    console.log(JSON.stringify(last, null, 2).slice(0, 6000));
    console.log("\n=== ALL CLOCKCHAIN MCP CALLS THIS RUN ===");
    for (const c of allCalls) console.log(`  ${c.status.toUpperCase()} ${c.tool} (${c.latencyMs}ms) → ${JSON.stringify(c.response ?? c.error ?? {}).slice(0, 160)}`);
    console.log(`\ndone=${done} · steps=${last?.steps?.length} · totalClockchainCalls=${allCalls.length}`);
  } finally {
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error("ERR:", e); process.exit(1); });
