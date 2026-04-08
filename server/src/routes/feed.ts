import { Router } from "express";
import type { Db } from "@agentdash/db";

// AgentDash: Feed routes
export function feedRoutes(db: Db) {
  const router = Router();
  return router;
}
