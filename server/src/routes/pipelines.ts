import { Router } from "express";
import type { Db } from "@agentdash/db";

// AgentDash: Pipeline routes
export function pipelineRoutes(db: Db) {
  const router = Router();
  return router;
}
