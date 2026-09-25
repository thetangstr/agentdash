import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { handshakeDemoService } from "../services/handshake-demo.js";
import { assertInstanceAdmin } from "./authz.js";

// AgentDash (security): the demo seeds two companies by fixed global names,
// creates agents in them and advances their workflow with no tenant check, so
// it is an instance-level operation. It is off unless explicitly enabled.
export function handshakeDemoEnabled(): boolean {
  const v = process.env.AGENTDASH_HANDSHAKE_DEMO_ENABLED;
  return v === "1" || v === "true";
}

// Turnkey two-company handshake demo. "Go" advances the scripted-real flow
// (idempotent; pauses at the two human approvals). It seeds companies/agents
// and runs real on-chain writes.
export function handshakeDemoRoutes(db: Db) {
  const router = Router();
  const svc = handshakeDemoService(db);

  router.post("/handshake-demo/go", async (req, res) => {
    // AgentDash (security): 404 when the flag is unset so the route is not
    // discoverable; instance admin required when it is set.
    if (!handshakeDemoEnabled()) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    assertInstanceAdmin(req);
    try {
      res.json(await svc.advance());
    } catch (err) {
      console.error("[handshake-demo] advance failed:", err);
      res.status(400).json({ error: "handshake_demo_failed" });
    }
  });

  return router;
}
