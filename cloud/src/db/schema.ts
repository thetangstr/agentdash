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
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  doublePrecision,
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

// AgentDash (GH #861): what a box is for. `demo` boxes hold upgrades by
// default; `canary` boxes are the first wave of every fleet rollout (SC-12).
export const BOX_PURPOSES = ["customer", "demo", "canary", "internal"] as const;
export type BoxPurpose = (typeof BOX_PURPOSES)[number];

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

// AgentDash (SC-9, GH #770): invite_codes_changed records imports, adds and revokes (counts and ids, never a code).
// AgentDash (SC-8, GH #769): fleet_secret_changed records a shared-secret change (name, version, fingerprint; never the value).
export const OPERATOR_AUDIT_KINDS = ["setting_changed", "admin_refused", "invite_codes_changed", "fleet_secret_changed"] as const;
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
    // AgentDash (SC-2, GH #763): the volumes' IDs, the Postgres image (major
    // pinned), how the web service was built, and the escrowed master key.
    webVolumeId: text("web_volume_id"),
    pgVolumeId: text("pg_volume_id"),
    pgImage: text("pg_image"),
    /** "image" (GHCR, by digest) or "source" (the release tag's commit, the fallback). */
    buildSource: text("build_source"),
    sourceCommit: text("source_commit"),
    /**
     * PAPERCLIP_SECRETS_MASTER_KEY sealed (libsodium sealed box) to the offline
     * escrow public key, base64. The control plane can write it but never
     * decrypt it; the plaintext key is never stored here.
     */
    masterKeyEscrow: text("master_key_escrow"),
    /**
     * The Railway volume IDs volumeCreate returned, recorded the moment they
     * exist: Railway's project listing shows a new volume late, and a retry
     * must wait for it rather than create a second one (GH #800 review).
     */
    pgVolumeCreatedId: text("pg_volume_created_id"),
    webVolumeCreatedId: text("web_volume_created_id"),
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
    /** AgentDash (GH #861): customer | demo | canary | internal. */
    purpose: text("purpose").$type<BoxPurpose>().notNull().default("customer"),
    // AgentDash (SC-8, GH #769): Stripe and Resend per box (spec §3.7).
    /** The box's own STRIPE_WEBHOOK_SECRET, encrypted: forwarded events are re-signed with it. */
    stripeWebhookSecretEnc: text("stripe_webhook_secret_enc"),
    /** Which fleet billing config (shared key version, price, trial days) the box last received. */
    stripeConfigRev: text("stripe_config_rev"),
    /**
     * A billing config sent to Railway but not yet running: it becomes
     * stripe_config_rev only once a deployment that started after
     * stripe_config_pending_since has succeeded (SC-8 review).
     */
    stripeConfigPendingRev: text("stripe_config_pending_rev"),
    stripeConfigPendingSince: timestamp("stripe_config_pending_since", { withTimezone: true }),
    /**
     * The box's Stripe customer, bound once from the first slug-routed event
     * and never rebound silently (unique): an event whose box_slug disagrees
     * with an existing binding is held for an operator (SC-8 review).
     */
    stripeCustomerId: text("stripe_customer_id"),
    /** Stripe `created` of the subscription event plan_tier was last taken from (out-of-order guard). */
    planTierEventAt: timestamp("plan_tier_event_at", { withTimezone: true }),
    /** The box's sending-only Resend API key id (never the key), for revocation at delete. */
    resendKeyId: text("resend_key_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("boxes_slug_uq").on(t.slug),
    index("boxes_account_idx").on(t.accountId),
    index("boxes_state_idx").on(t.state),
    // AgentDash (SC-8 review): a Stripe customer belongs to at most one box.
    uniqueIndex("boxes_stripe_customer_uq").on(t.stripeCustomerId),
    check("boxes_kind_ck", inList("kind", BOX_KINDS)),
    check("boxes_state_ck", inList("state", BOX_STATES)),
    check("boxes_purpose_ck", inList("purpose", BOX_PURPOSES)),
  ],
);

/**
 * The provisioning job queue (SC-3, GH #764; runner in ../jobs/runner.ts).
 * Workers claim rows with `FOR UPDATE SKIP LOCKED` on (state='queued',
 * run_after <= now()) or an expired lease (state='running', locked_until <
 * now(): a crashed worker), and hold a 5-minute lease in `locked_until`
 * renewed by heartbeat. `step` is the step in progress, so a resumed job
 * starts there; `attempt` counts claims; `started_at` is the first claim, for
 * the per-kind cap (30 minutes for provision).
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
    maxAttempts: integer("max_attempts").notNull().default(5),
    startedAt: timestamp("started_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Non-secret job input (e.g. who requested it, the release tag). Never a credential. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** Always passed through the redacting logger's `redactString()` before it is written. */
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.state, t.runAfter),
    index("jobs_lease_idx").on(t.state, t.lockedUntil),
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

/** Purpose-separated self-hosted and hosted admission codes. Only HMACs are stored. */
export const INVITE_PURPOSES = ["self_hosted", "hosted_beta"] as const;
export type InvitePurpose = (typeof INVITE_PURPOSES)[number];
export const inviteCodes = pgTable(
  "invite_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull(),
    purpose: text("purpose").$type<InvitePurpose>().notNull().default("self_hosted"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByAccountId: uuid("consumed_by_account_id").references(() => accounts.id),
    consumedBoxId: uuid("consumed_box_id").references(() => boxes.id),
    label: text("label"),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("invite_codes_hash_uq").on(t.codeHash),
    check("invite_codes_purpose_ck", inList("purpose", INVITE_PURPOSES)),
    check("invite_codes_consumption_ck", sql`(
      (${t.consumedAt} is null and ${t.consumedByAccountId} is null and ${t.consumedBoxId} is null)
      or (${t.purpose} = 'hosted_beta' and ${t.consumedAt} is not null and ${t.consumedByAccountId} is not null and ${t.consumedBoxId} is not null)
    )`),
  ],
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

// ---- Front door (SC-7, GH #768) ----------------------------------------

/**
 * A signup on /start, before its email is verified. The box is created only
 * when the magic link is used (spec §5.1: verification before provisioning),
 * so an unverified signup never holds a slug for long: it counts against a
 * slug only while its link is unexpired.
 */
export const signupRequests = pgTable(
  "signup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    emailTokenId: uuid("email_token_id").references(() => emailTokens.id),
    hostedInviteId: uuid("hosted_invite_id").references(() => inviteCodes.id),
    slug: text("slug").notNull(),
    workspaceName: text("workspace_name").notNull(),
    /** The client address the signup came from (per-IP limits, spec §5.1). */
    ip: text("ip"),
    /** True when no bot check ran (Turnstile not configured): the box may only wait on the list. */
    unverifiedHuman: boolean("unverified_human").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    boxId: uuid("box_id").references(() => boxes.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("signup_requests_slug_idx").on(t.slug, t.expiresAt),
    index("signup_requests_ip_idx").on(t.ip, t.createdAt),
    index("signup_requests_account_idx").on(t.accountId),
  ],
);

/** A short-lived front-door session, set when a magic link is used. Only the token's hash is stored. */
export const cloudSessions = pgTable(
  "cloud_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cloud_sessions_hash_uq").on(t.tokenHash)],
);

/**
 * Rate-limit hits for the public API, one row per counted request. Durable
 * and shared across replicas; counted over a sliding window. The runtime
 * role has no DELETE, so rows are never removed (they are tiny).
 */
export const rateEvents = pgTable(
  "rate_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("rate_events_lookup_idx").on(t.bucket, t.key, t.createdAt)],
);

// ---- Fleet health, alerts, idle policy, spend (SC-10, GH #771) -----------

export const HEALTH_PATHS = ["direct", "router"] as const;
export type HealthPath = (typeof HEALTH_PATHS)[number];

export const HEALTH_STATUSES = ["ok", "failing", "unknown"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/**
 * The latest health of each box on each path (spec §6.3): `direct` is the
 * box's Railway host (health is exempt from the edge secret), `router` is
 * https://<slug>.<edge domain> through the edge router. One row per box and
 * path; `consecutive_failures` drives the 3-failure alert.
 */
export const boxHealth = pgTable(
  "box_health",
  {
    boxId: uuid("box_id")
      .notNull()
      .references(() => boxes.id),
    path: text("path").$type<HealthPath>().notNull(),
    status: text("status").$type<HealthStatus>().notNull().default("unknown"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    lastError: text("last_error"),
    release: text("release"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("box_health_box_path_uq").on(t.boxId, t.path),
    check("box_health_path_ck", inList("path", HEALTH_PATHS)),
    check("box_health_status_ck", inList("status", HEALTH_STATUSES)),
  ],
);

/** Every health poll, for `box health <slug>`. Pruned by prune_fleet_history() (the runtime role has no DELETE). */
export const boxHealthChecks = pgTable(
  "box_health_checks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    boxId: uuid("box_id")
      .notNull()
      .references(() => boxes.id),
    path: text("path").$type<HealthPath>().notNull(),
    ok: boolean("ok").notNull(),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("box_health_checks_box_idx").on(t.boxId, t.checkedAt),
    index("box_health_checks_time_idx").on(t.checkedAt),
    check("box_health_checks_path_ck", inList("path", HEALTH_PATHS)),
  ],
);

export const FLEET_ALERT_STATES = ["firing", "resolved"] as const;
export type FleetAlertState = (typeof FLEET_ALERT_STATES)[number];

/**
 * One row per alert condition (`key`, e.g. `health:direct:<box id>`,
 * `router_5xx`, `cert:<host>`, `spend`): dedupe, reminders, flap
 * suppression and recovery notices (../monitor/alert-center.ts).
 */
export const fleetAlerts = pgTable(
  "fleet_alerts",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull(),
    state: text("state").$type<FleetAlertState>().notNull(),
    subject: text("subject").notNull(),
    boxId: uuid("box_id").references(() => boxes.id),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    firstFiredAt: timestamp("first_fired_at", { withTimezone: true }).notNull(),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }).notNull(),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
    notifyCount: integer("notify_count").notNull().default(0),
    suppressedCount: integer("suppressed_count").notNull().default(0),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [index("fleet_alerts_state_idx").on(t.state), check("fleet_alerts_state_ck", inList("state", FLEET_ALERT_STATES))],
);

/**
 * Per-replica request counts from the edge router, one row per flush
 * (written only through edge_record_stats(), migration 0009). The control
 * plane sums a window to get the router's 5xx rate.
 */
export const edgeStats = pgTable(
  "edge_stats",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    replica: text("replica").notNull(),
    requests: integer("requests").notNull(),
    serverErrors: integer("server_errors").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("edge_stats_time_idx").on(t.createdAt)],
);

export const MONITOR_READING_KINDS = ["spend", "cert", "router_5xx"] as const;
export type MonitorReadingKind = (typeof MONITOR_READING_KINDS)[number];

/**
 * Point readings for the fleet summary: the spend reading (`value` in USD,
 * null when not available), certificate days left per host, the router's
 * 5xx rate. Pruned by prune_fleet_history().
 */
export const monitorReadings = pgTable(
  "monitor_readings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").$type<MonitorReadingKind>().notNull(),
    subject: text("subject").notNull(),
    value: doublePrecision("value"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("monitor_readings_kind_idx").on(t.kind, t.subject, t.createdAt),
    check("monitor_readings_kind_ck", inList("kind", MONITOR_READING_KINDS)),
  ],
);

export const IDLE_NOTICE_KINDS = ["suspend_warning", "delete_warning"] as const;
export type IdleNoticeKind = (typeof IDLE_NOTICE_KINDS)[number];

/**
 * The idle policy's customer emails (spec §5.2), one per idle period: a
 * period is identified by when it started (`idle_since`), so a box that is
 * used again and goes idle again is warned again.
 */
export const boxIdleNotices = pgTable(
  "box_idle_notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boxId: uuid("box_id")
      .notNull()
      .references(() => boxes.id),
    kind: text("kind").$type<IdleNoticeKind>().notNull(),
    idleSince: timestamp("idle_since", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("box_idle_notices_period_uq").on(t.boxId, t.kind, t.idleSince),
    check("box_idle_notices_kind_ck", inList("kind", IDLE_NOTICE_KINDS)),
  ],
);

// ---- Fleet upgrade (SC-12, GH #773) -------------------------------------

export const ROLLOUT_STATES = ["running", "completed", "cancelled"] as const;
export type RolloutState = (typeof ROLLOUT_STATES)[number];

/**
 * planned → queued (job enqueued) → running → succeeded, or → rolling_back →
 * rolled_back | failed. `skipped` when a planned box became ineligible (held,
 * no longer active, already on the release).
 */
export const BOX_UPGRADE_STATES = ["planned", "queued", "running", "rolling_back", "succeeded", "rolled_back", "failed", "skipped"] as const;
export type BoxUpgradeState = (typeof BOX_UPGRADE_STATES)[number];
export const BOX_UPGRADE_LIVE_STATES = ["queued", "running", "rolling_back"] as const satisfies readonly BoxUpgradeState[];
export const BOX_UPGRADE_DONE_STATES = ["succeeded", "rolled_back", "failed", "skipped"] as const satisfies readonly BoxUpgradeState[];

/**
 * One fleet rollout of a release (spec §6.1). Its waves are planned once, at
 * start, into box_upgrades; pausing is the global `rollout_paused` setting.
 * At most one rollout runs at a time.
 */
export const rollouts = pgTable(
  "rollouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseTag: text("release_tag").notNull(),
    imageDigest: text("image_digest").notNull(),
    /** The tag's commit, when GitHub answered: a box's health releaseCommit must match it when reported. */
    releaseCommit: text("release_commit"),
    state: text("state").$type<RolloutState>().notNull().default("running"),
    /** The operator's "now": waves start outside the nightly window. */
    ignoreWindow: boolean("ignore_window").notNull().default(false),
    pausedReason: text("paused_reason"),
    createdBy: text("created_by").notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("rollouts_one_running_uq").on(t.state).where(sql`state = 'running'`),
    check("rollouts_state_ck", inList("state", ROLLOUT_STATES)),
  ],
);

/**
 * One box's upgrade: a planned member of a rollout wave, or (rollout_id null)
 * an operator's single-box upgrade. The upgrade job (../jobs/upgrade.ts)
 * records every fact it needs to resume or roll back here as it learns it.
 */
export const boxUpgrades = pgTable(
  "box_upgrades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boxId: uuid("box_id")
      .notNull()
      .references(() => boxes.id),
    rolloutId: uuid("rollout_id").references(() => rollouts.id),
    wave: integer("wave").notNull().default(0),
    state: text("state").$type<BoxUpgradeState>().notNull().default("planned"),
    jobId: uuid("job_id").references(() => jobs.id),
    toTag: text("to_tag").notNull(),
    toDigest: text("to_digest").notNull(),
    toCommit: text("to_commit"),
    fromTag: text("from_tag"),
    fromDigest: text("from_digest"),
    fromBuildSource: text("from_build_source"),
    fromSourceCommit: text("from_source_commit"),
    fromDeploymentId: text("from_deployment_id"),
    /** Pre-upgrade snapshot ids per volume ({ pg, web }). */
    snapshots: jsonb("snapshots").$type<Record<string, unknown>>(),
    deploymentId: text("deployment_id"),
    rollbackDeploymentId: text("rollback_deployment_id"),
    /** When the rollback was asked of Railway, so a retry waits for it instead of asking twice. */
    rollbackRequestedAt: timestamp("rollback_requested_at", { withTimezone: true }),
    /** Why it was skipped, failed or rolled back (redacted). */
    error: text("error"),
    lastHealth: jsonb("last_health").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("box_upgrades_rollout_idx").on(t.rolloutId, t.wave, t.state),
    index("box_upgrades_box_idx").on(t.boxId, t.createdAt),
    uniqueIndex("box_upgrades_rollout_box_uq").on(t.rolloutId, t.boxId),
    // At most one upgrade in flight per box (a rollout's and a single-box one cannot overlap).
    uniqueIndex("box_upgrades_one_live_per_box_uq").on(t.boxId).where(sql`state in ('queued', 'running', 'rolling_back')`),
    check("box_upgrades_state_ck", inList("state", BOX_UPGRADE_STATES)),
  ],
);

// ---- Off-box backups (GH #733) -----------------------------------------

export const BACKUP_TRIGGERS = ["scheduled", "manual"] as const;
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];
export const BACKUP_STATES = ["running", "succeeded", "failed", "pruned"] as const;
export type BackupState = (typeof BACKUP_STATES)[number];

/**
 * One off-box database backup of a box (cloud/src/backups/). The object in
 * the store is encrypted to the offline backup key; this row holds only where
 * it is and what it should hash to. A scheduled backup is one row per box per
 * UTC day (the unique index is the claim: a retry re-claims the same row).
 * The runtime role has no DELETE: a pruned backup keeps its row as `pruned`.
 */
export const boxBackups = pgTable(
  "box_backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boxId: uuid("box_id")
      .notNull()
      .references(() => boxes.id),
    trigger: text("trigger").$type<BackupTrigger>().notNull(),
    /** The UTC day (YYYY-MM-DD) the backup belongs to. */
    backupDay: text("backup_day").notNull(),
    state: text("state").$type<BackupState>().notNull().default("running"),
    attempt: integer("attempt").notNull().default(1),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** Path inside the bucket prefix. */
    objectPath: text("object_path"),
    /** Encrypted size and SHA-256 (hex) of the stored object. */
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    /** Plaintext (gzipped dump) size. */
    plainBytes: bigint("plain_bytes", { mode: "number" }),
    /** Id of the offline public key the backup is sealed to. */
    sealedTo: text("sealed_to"),
    format: text("format"),
    /** Core-table row counts the box reported (numbers only). */
    counts: jsonb("counts").$type<Record<string, number | null>>(),
    release: text("release"),
    /** Redacted. */
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    prunedAt: timestamp("pruned_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("box_backups_box_idx").on(t.boxId, t.createdAt),
    uniqueIndex("box_backups_scheduled_day_uq")
      .on(t.boxId, t.backupDay)
      .where(sql`"trigger" = 'scheduled'`),
    check("box_backups_trigger_ck", inList("trigger", BACKUP_TRIGGERS)),
    check("box_backups_state_ck", inList("state", BACKUP_STATES)),
  ],
);

// ---- Stripe forwarding and fleet secrets (SC-8, GH #769) ---------------

/**
 * Secrets shared by the whole fleet, encrypted under CLOUD_DATA_KEY: the
 * boxes' shared restricted Stripe key, and the account webhook endpoint's
 * signing secret when the control plane created the endpoint. `version`
 * goes up on every change; `fingerprint` (sha256) tells a re-run of the same
 * value from a new one without decrypting.
 */
export const fleetSecrets = pgTable("fleet_secrets", {
  name: text("name").primaryKey(),
  valueEnc: text("value_enc").notNull(),
  fingerprint: text("fingerprint").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
  updatedBy: text("updated_by"),
});

export const STRIPE_EVENT_STATES = ["pending", "delivered", "dropped", "dead"] as const;
export type StripeEventState = (typeof STRIPE_EVENT_STATES)[number];

/**
 * Every Stripe event the account endpoint accepted (spec §3.7), one row per
 * event id: the idempotency key, the forwarding queue and the dead-letter
 * view in one. The raw body is kept encrypted only while it may still be
 * delivered; a dropped event keeps no body.
 */
export const stripeEvents = pgTable(
  "stripe_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    livemode: boolean("livemode").notNull().default(false),
    /** Stripe's `created` for the event. */
    stripeCreatedAt: timestamp("stripe_created_at", { withTimezone: true }),
    boxSlug: text("box_slug"),
    boxId: uuid("box_id").references(() => boxes.id),
    state: text("state").$type<StripeEventState>().notNull().default("pending"),
    /** Why it was dropped or parked, or the last delivery outcome. Never a secret or a body. */
    reason: text("reason"),
    bodyEnc: text("body_enc"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastStatus: integer("last_status"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("stripe_events_event_id_uq").on(t.eventId),
    index("stripe_events_due_idx").on(t.state, t.nextAttemptAt),
    index("stripe_events_box_idx").on(t.boxId, t.createdAt),
    check("stripe_events_state_ck", inList("state", STRIPE_EVENT_STATES)),
  ],
);
