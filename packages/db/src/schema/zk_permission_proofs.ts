import { pgTable, uuid, text, integer, bigint, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { mandates } from "./mandates.js";

// CLO-137: off-chain storage for a server-side ZK permission proof (Semaphore v4).
// The 32-byte proofHash rides the existing attest_action anchor path (inputs.permission_proof);
// the FULL proof bytes live here so a relying party can re-verify off-chain, and the
// nullifier is stored UNIQUE so a double-use (replay) is detectable at the DB level.
// The network never sees these bytes — verification is off-chain by design.
export const zkPermissionProofs = pgTable(
  "zk_permission_proofs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // The authority = the mandate that granted the permission (nullable for standalone proofs).
    mandateId: uuid("mandate_id").references(() => mandates.id),
    granteeAgentId: uuid("grantee_agent_id"),
    scheme: text("scheme").notNull(), // e.g. "semaphore-v4"
    // Public signals (all also embedded in proofBytes; duplicated for cheap querying).
    proofHash: text("proof_hash").notNull(), // SHA-256(canonical(proofBytes)) — the anchored digest
    nullifier: text("nullifier").notNull(), // UNIQUE — double-use detectable
    authority: text("authority").notNull(), // Merkle root of the authority's member set
    scope: text("scope").notNull(), // human scope string (e.g. the mandate action)
    // T — numeric epoch (seconds). Kept numeric so "valid at T" reconciles with the
    // anchor's consensusTime later. bigint(mode:number) is lossless for epoch seconds.
    validAt: bigint("valid_at", { mode: "number" }).notNull(),
    // The full canonical proof JSON (off-chain). verifyProof re-hydrates from this.
    proofBytes: text("proof_bytes").notNull(),
    // Anchor receipt fields — populated when the attest that carried proofHash confirmed.
    ledgerId: text("ledger_id"),
    blockHeight: integer("block_height"),
    eventHash: text("event_hash"),
    receiptStatus: text("receipt_status"), // anchored | pending | degraded
    // Raw attest receipt, kept so a verifier can run verify_receipt (keyless re-check).
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Nullifier reuse across the whole instance is a double-use — enforce globally.
    nullifierUnique: unique("zk_permission_proofs_nullifier_key").on(table.nullifier),
    companyProofIdx: index("zk_permission_proofs_company_proof_idx").on(table.companyId, table.proofHash),
    mandateIdx: index("zk_permission_proofs_mandate_idx").on(table.companyId, table.mandateId),
  }),
);
