import { Router } from "express";
import type { Db } from "@agentdash/db";

// AgentDash: Action Proposals routes
export function actionProposalRoutes(db: Db) {
  const router = Router();
  return router;
}
