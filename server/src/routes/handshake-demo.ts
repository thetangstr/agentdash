import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { handshakeDemoService } from "../services/handshake-demo.js";
import { withClockchainCallRecorder, type ClockchainCall } from "../services/clockchain.js";
import { assertBoard } from "./authz.js";

// Turnkey two-company handshake demo. "Go" advances the scripted-real flow
// (idempotent; pauses at the two human approvals; agent-driven + ZK when the
// AGENTDASH_HANDSHAKE_AGENT_DRIVEN / AGENTDASH_ZK_PROOF_ENABLED flags are on).
// Board-only: it seeds companies/agents and runs real on-chain writes. Every
// live Clockchain MCP call made during the advance is captured and returned as
// `clockchainCalls` so the demo surface can show exactly what the gateway returned.
export function handshakeDemoRoutes(db: Db) {
  const router = Router();
  const svc = handshakeDemoService(db);

  router.post("/handshake-demo/go", async (req, res) => {
    assertBoard(req);
    try {
      const clockchainCalls: ClockchainCall[] = [];
      const result = await withClockchainCallRecorder(
        (c) => clockchainCalls.push(c),
        () => svc.advance(),
      );
      res.json({ ...result, clockchainCalls });
    } catch (err) {
      console.error("[handshake-demo] advance failed:", err);
      res.status(400).json({ error: "handshake_demo_failed" });
    }
  });

  return router;
}
