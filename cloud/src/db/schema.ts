// AgentDash: control-plane schema for the self-serve cloud (spec
// docs/superpowers/specs/2026-09-25-self-serve-cloud-design.md §3.2, §3.4).
// This is the control plane's OWN database. It never imports or touches the
// box schema in packages/db.
//
// Secrets: `*_enc` columns hold AES-256-GCM ciphertext under CLOUD_DATA_KEY
// (see ../crypto.ts). A box's auth secret, secrets master key and Postgres
// password are never stored here at all.
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

function inList(column: string, values: readonly string[]) {
  return sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(", ")})`);
}

// ---- States (§3.4) -------------------------------------------------------

export const ACCOUNT_STATUSES = ["pending_verification", "active", "blocked", "deleted"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const EMAIL_TOKEN_PURPOSES = ["verify", "find"] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

export const BOX_KINDS = ["dedicated", "shared"] as const; // `shared` reserved for Option B
export type BoxKind = (typeof BOX_KINDS)[number];

export const BOX_STATES = [
  "requested",
  "waitlisted",
  "provisioning",
  "awaiting_claim",
  "active",
  "suspended",
  "pending_delete",
  "failed",
  "cleanup",
  "deleted",
] as const;
export type BoxState = (typeof BOX_STATES)[number];

export const JOB_KINDS = ["provision", "close_signup", "suspend", "resume", "upgrade", "delete"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATES = ["queued", "running", "succeeded", "failed", "dead"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const WAITLIST_STATES = ["waiting", "approved", "rejected"] as const;
export type WaitlistState = (typeof WAITLIST_STATES)[number];

// ---- Allowed transitions (§3.4), enforced by DB triggers ----------------
//
// Migration 0001 installs BEFORE INSERT/UPDATE triggers that refuse any state
// change not listed here, and any row inserted in a state other than the
// initial ones. db.test.ts checks the database against these maps pair by
// pair, so the two cannot drift. A same-state write is always allowed.

export const BOX_INITIAL_STATES: readonly BoxState[] = ["requested", "waitlisted"];
export const BOX_TRANSITIONS: Record<BoxState, readonly BoxState[]> = {
  requested: ["waitlisted", "provisioning", "failed", "deleted"],
  waitlisted: ["provisioning", "deleted"],
  provisioning: ["awaiting_claim", "failed"],
  awaiting_claim: ["active", "failed", "cleanup"],
  active: ["suspended", "pending_delete"],
  suspended: ["active", "pending_delete"],
  pending_delete: ["deleted"],
  failed: ["provisioning", "cleanup"],
  cleanup: ["deleted", "failed"],
  deleted: [],
};

export const JOB_INITIAL_STATES: readonly JobState[] = ["queued"];
export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["running", "dead"],
  running: ["queued", "succeeded", "failed", "dead"],
  failed: ["queued", "dead"],
  succeeded: [],
  dead: [],
};

export const ACCOUNT_INITIAL_STATES: readonly AccountStatus[] = ["pending_verification"];
export const ACCOUNT_TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  pending_verification: ["active", "blocked", "deleted"],
  active: ["blocked", "deleted"],
  blocked: ["active", "deleted"],
  deleted: [],
};

export const OPERATOR_AUDIT_KINDS = ["setting_changed", "admin_refused"] as const;
export type OperatorAuditKind = (typeof OPERATOR_AUDIT_KINDS)[number];

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---- Tables (§3.2) -------------------------------------------------------

/** A person on the front door. Not a box user (two identity domains, #623 D-S5). */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: citext("email").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    signupIp: text("signup_ip"),
    status: text("status").$type<AccountStatus>().notNull().default("pending_verification"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("accounts_email_uq").on(t.email),
    check("accounts_status_ck", inList("status", ACCOUNT_STATUSES)),
  ],
);

export const emailTokens = pgTable(
  "email_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    purpose: text("purpose").$type<EmailTokenPurpose>().notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("email_tokens_hash_uq").on(t.tokenHash),
    index("email_tokens_account_idx").on(t.accountId),
    check("email_tokens_purpose_ck", inList("purpose", EMAIL_TOKEN_PURPOSES)),
  ],
);

/** Shards boxes across Railway workspaces past the 100-projects-per-workspace limit. */
export const railwayWorkspaces = pgTable(
  "railway_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    railwayWorkspaceId: text("railway_workspace_id").notNull(),
    name: text("name").notNull(),
    projectCount: integer("project_count").notNull().default(0),
    capacity: integer("capacity").notNull().default(80),
    accepting: boolean("accepting").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("railway_workspaces_railway_id_uq").on(t.railwayWorkspaceId)],
);

export const boxes = pgTable(
  "boxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    slug: text("slug").notNull(),
    kind: text("kind").$type<BoxKind>().notNull().default("dedicated"),
    state: text("state").$type<BoxState>().notNull().default("requested"),
    // Each Railway ID is recorded the moment it is created (resumable jobs).
    railwayWorkspaceId: uuid("railway_workspace_id").references(() => railwayWorkspaces.id),
    projectId: text("project_id"),
    environmentId: text("environment_id"),
    webServiceId: text("web_service_id"),
    pgServiceId: text("pg_service_id"),
    upstreamHost: text("upstream_host"),
    publicUrl: text("public_url"),
    releaseTag: text("release_tag"),
    imageDigest: text("image_digest"),
    edgeSecretEnc: text("edge_secret_enc"),
    claimCodeEnc: text("claim_code_enc"),
    claimCodeHash: text("claim_code_hash"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    planTier: text("plan_tier").notNull().default("free"),
    lastHealth: jsonb("last_health").$type<Record<string, unknown>>(),
    lastHumanRequestAt: timestamp("last_human_request_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
    holdUpgrades: boolean("hold_upgrades").notNull().default(false),
    cohort: text("cohort"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("boxes_slug_uq").on(t.slug),
    index("boxes_account_idx").on(t.accountId),
    index("boxes_state_idx").on(t.state),
    check("boxes_kind_ck", inList("kind", BOX_KINDS)),
    check("boxes_state_ck", inList("state", BOX_STATES)),
  ],
);

/**
 * The provisioning job queue. Workers claim rows with
 * `FOR UPDATE SKIP LOCKED` on (state='queued', run_after <= now()) and hold a
 * lease in `locked_until` renewed by heartbeat (the runner is SC-3, #764).
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boxId: uuid("box_id")
      .notNull()
      .references(() => boxes.id),
    kind: text("kind").$type<JobKind>().notNull(),
    state: text("state").$type<JobState>().notNull().default("queued"),
    step: text("step"),
    attempt: integer("attempt").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lockedBy: text("locked_by"),
    /** Always passed through the redacting logger's `redact()` before it is written. */
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.state, t.runAfter),
    index("jobs_box_idx").on(t.boxId),
    // At most one live job of a kind per box.
    uniqueIndex("jobs_one_live_per_box_kind_uq")
      .on(t.boxId, t.kind)
      .where(sql`state in ('queued', 'running')`),
    check("jobs_kind_ck", inList("kind", JOB_KINDS)),
    check("jobs_state_ck", inList("state", JOB_STATES)),
  ],
);

/** Append-only audit trail (UPDATE, DELETE and TRUNCATE refused by trigger, migration 0001). */
export const boxEvents = pgTable(
  "box_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    boxId: uuid("box_id").references(() => boxes.id),
    kind: text("kind").notNull(),
    actor: text("actor").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("box_events_box_idx").on(t.boxId, t.createdAt)],
);

/**
 * Append-only audit of the operator surface (GH #778): every setting change
 * (old and new value) and every refused /internal request. UPDATE, DELETE and
 * TRUNCATE are refused by trigger (migration 0001).
 */
export const operatorAudit = pgTable(
  "operator_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").$type<OperatorAuditKind>().notNull(),
    actor: text("actor").notNull(),
    ip: text("ip"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("operator_audit_kind_idx").on(t.kind, t.createdAt),
    check("operator_audit_kind_ck", inList("kind", OPERATOR_AUDIT_KINDS)),
  ],
);

/** The self-hosted invite validator's codes (§7). Only hashes are stored. */
export const inviteCodes = pgTable(
  "invite_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull(),
    label: text("label"),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("invite_codes_hash_uq").on(t.codeHash)],
);

export const waitlist = pgTable(
  "waitlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").references(() => accounts.id),
    email: citext("email").notNull(),
    requestedSlug: text("requested_slug"),
    state: text("state").$type<WaitlistState>().notNull().default("waiting"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("waitlist_state_idx").on(t.state, t.createdAt),
    check("waitlist_state_ck", inList("state", WAITLIST_STATES)),
  ],
);

/** Operator settings. Missing rows fall back to the launch defaults in ../settings.ts. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
  updatedBy: text("updated_by"),
});
