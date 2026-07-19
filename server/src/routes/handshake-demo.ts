import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { handshakeDemoService } from "../services/handshake-demo.js";
import { assertBoard } from "./authz.js";

// Turnkey two-company handshake demo. "Go" advances the scripted-real flow
// (idempotent; pauses at the two human approvals). Board-only: it seeds
// companies/agents and runs real on-chain writes.
export function handshakeDemoRoutes(db: Db) {
  const router = Router();
  const svc = handshakeDemoService(db);

  router.post("/handshake-demo/go", async (req, res) => {
    assertBoard(req);
    try {
      res.json(await svc.advance());
    } catch (err) {
      console.error("[handshake-demo] advance failed:", err);
      res.status(400).json({ error: "handshake_demo_failed" });
    }
  });

  return router;
}
