import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { clockchainService } from "../services/clockchain.js";
import { zkPermissionService } from "../services/zk-permission.js";
import { assertCompanyAccess } from "./authz.js";

// CLO-137 verifier surface. Runs the two INDEPENDENT relying-party checks for a stored proof:
//   (a) off-chain ZK verify + public-signal binding  => the proof itself is valid;
//   (b) verify_receipt against the immutable block    => the proof_hash was anchored at T.
// A wrong-scope proof FAILS (a) while still being anchored (b) — intended. The receipt proves
// TIME, never that the network verified the proof.
export function zkPermissionProofRoutes(db: Db) {
  const router = Router();
  const zk = zkPermissionService(db);
  const clock = clockchainService();

  router.get("/companies/:companyId/zk-permission-proofs/:proofHash/verify", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await zk.verifyStoredProof(companyId, req.params.proofHash as string, clock);
    if (!result.found) {
      res.status(404).json({ error: "proof_not_found" });
      return;
    }
    res.json(result);
  });

  return router;
}
