// AgentDash-MK: the destructive-action classifier (T5a-1).
//
// See doc/plans/2026-08-04-t5-destructive-classifier.md.
//
// The owner ceiling carries a single `destructiveActions` mode
// (`blocked | approval_required | allowed`). That mode says *how* destructive
// work is handled; this module defines *which* actions the mode applies to.
//
// It is a closed allowlist, not a guess: reads/queries/fetches and internal
// messages are the only things that are never destructive. Everything
// write-shaped that cannot be placed into a known-safe read class fails closed
// to `unclassified_write` (destructive = true) — the same posture as slice E's
// E3. That is the whole safety contract: a new provider or a new operation the
// classifier has never seen is treated as destructive until someone teaches it
// otherwise, never silently allowed.
//
// It is pure and deterministic so BOTH server-side enforcement (the connector
// -send apply path and `bridgeService.createTask`) and the onboarding UI import
// the exact same truth — the classifier and the list the owner is shown can
// never disagree.

/**
 * The nine default destructive-action classes. Each is derivable from the
 * connector `(provider, operation)` pair or from the bridge task class — the
 * only facts the authorization chokepoint has. These are the toggle rows the
 * onboarding UI renders.
 */
export const DESTRUCTIVE_ACTION_CLASS_KEYS = [
  "external_record_delete",
  "external_record_merge",
  "external_bulk_mutation",
  "outbound_external_message",
  "financial_action",
  "access_grant_or_revoke",
  "external_publish",
  "local_machine_mutation",
  "credential_or_connection_change",
] as const;

export type DestructiveActionClassKey = (typeof DESTRUCTIVE_ACTION_CLASS_KEYS)[number];

/**
 * The non-togglable outcomes that sit alongside the nine classes.
 * `safe_read` and `new_private_copy` are never destructive; `unclassified_write`
 * is the fail-closed catch-all (always destructive).
 *
 * `new_private_copy` (document access slice 5) is a write that creates one new
 * file in the steward's own storage and cannot touch anything that exists: the
 * Microsoft `upload_new` operation, which only ever runs after the steward
 * approves it. Not destructive, so a `blocked` ceiling does not refuse it, but
 * still approval-gated by the `connector_send` path it travels on.
 */
export type ActionClassification =
  | DestructiveActionClassKey
  | "safe_read"
  | "new_private_copy"
  | "unclassified_write";

export interface DestructiveActionClassEntry {
  /** Stable machine key. Never renamed — persistence and enforcement key off it. */
  key: DestructiveActionClassKey;
  /** One line: *what it is*. */
  label: string;
  /** One line: *why it is destructive* — the sentence the onboarding UI shows. */
  rationale: string;
  /** A concrete AgentDash example, for the onboarding tooltip. */
  example: string;
}

/**
 * The default destructive-action class list, in the design doc's table order.
 * This is a CODE CONSTANT — shipping enforcement needs no persistence. Owner-
 * added custom classes (T5b) need a migration and are out of scope here.
 */
export const DEFAULT_DESTRUCTIVE_ACTION_CLASSES: readonly DestructiveActionClassEntry[] =
  Object.freeze([
    {
      key: "external_record_delete",
      // AgentDash (scan 2, E6): labels and rationales are the onboarding
      // mandate's fine print, so they are written for the owner, not for us.
      label: "Delete or archive a record in another system, like your CRM",
      rationale: "Once it is gone, it cannot be brought back.",
      example: "HubSpot: delete a contact, deal, or company.",
    },
    {
      key: "external_record_merge",
      label: "Merge or dedupe records",
      rationale: "Merged records cannot be split apart again.",
      example: "HubSpot: merge two companies.",
    },
    {
      key: "external_bulk_mutation",
      label: "One action that writes many external records at once",
      rationale: "One mistake is repeated across every record it touches.",
      example: "Bulk-update a HubSpot list.",
    },
    {
      key: "outbound_external_message",
      label: "Send a message or email to a recipient outside the company",
      rationale: "It cannot be unsent, and a real person outside the company reads it.",
      example: "WhatsApp or email to a lead or customer.",
    },
    {
      key: "financial_action",
      label: "Move money or commit spend",
      rationale: "Money that has moved cannot simply be moved back.",
      example: "Send an invoice, issue a refund, change a plan.",
    },
    {
      key: "access_grant_or_revoke",
      label: "Change who can access external data or systems",
      rationale: "Changes who can see or change things, often without anyone noticing.",
      example: "Add a SharePoint share; add a portal user.",
    },
    {
      key: "external_publish",
      label: "Make content externally or publicly visible",
      rationale: "Once something is public, it cannot reliably be taken back.",
      example: "Publish a doc; create a public share link.",
    },
    {
      key: "local_machine_mutation",
      label: "Change files or run commands on someone's computer",
      rationale: "AgentDash cannot limit what happens on that computer, so asking first is the only safeguard.",
      example: "Write or delete files, or run a command that changes something.",
    },
    {
      key: "credential_or_connection_change",
      label: "Create, rotate, or revoke a connection, key, or secret",
      rationale: "Can lock out or expose access.",
      example: "Revoke a HubSpot BYO key.",
    },
  ] satisfies DestructiveActionClassEntry[]);

// ---------------------------------------------------------------------------
// Classifier input — the shape the chokepoint fills in.
// ---------------------------------------------------------------------------

/**
 * A connector-mediated action. The chokepoint knows the `provider` and a
 * normalized `operation` verb (the same facts the connector-send apply path
 * already carries on the approval payload — e.g. HubSpot's `operation`).
 */
export interface ClassifyConnectorAction {
  kind: "connector";
  /** Connector provider key, e.g. "hubspot", "whatsapp", "google", "microsoft". */
  provider: string;
  /**
   * Normalized operation verb. Reads (`read`/`get`/`list`/`query`/`fetch`/
   * `search`) are safe; a named destructive verb maps to its class; anything
   * else write-shaped fails closed to `unclassified_write`.
   */
  operation: string;
  /**
   * For message-shaped operations only: whether the recipient is inside or
   * outside the company. Defaults to `external` (fail closed — an unqualified
   * message is treated as reaching the outside world).
   */
  recipientScope?: "internal" | "external";
}

/**
 * A bridge task queued to a human's machine. The chokepoint
 * (`bridgeService.createTask`) knows only the task class: `read` observes,
 * `act` mutates. An unknown class fails closed.
 */
export interface ClassifyBridgeAction {
  kind: "bridge";
  /** Bridge task class: `read` (safe) or `act` (local machine mutation). */
  taskClass: string;
}

export type ClassifyActionInput = ClassifyConnectorAction | ClassifyBridgeAction;

export interface ClassifyActionResult {
  class: ActionClassification;
  /** True for every class except `safe_read` and `new_private_copy`. */
  destructive: boolean;
}

// ---------------------------------------------------------------------------
// Operation vocabulary.
// ---------------------------------------------------------------------------

/** The only never-destructive connector operations. */
const READ_OPERATIONS: ReadonlySet<string> = new Set([
  "read",
  "get",
  "list",
  "query",
  "fetch",
  "search",
]);

/**
 * Named destructive operations → their class. A message-shaped operation
 * (`outbound_external_message`) is resolved separately so an internal recipient
 * can downgrade it to a safe read.
 */
const OPERATION_CLASS: Readonly<Record<string, DestructiveActionClassKey>> = Object.freeze({
  delete: "external_record_delete",
  archive: "external_record_delete",
  merge: "external_record_merge",
  dedupe: "external_record_merge",
  bulk_update: "external_bulk_mutation",
  bulk_mutation: "external_bulk_mutation",
  batch_update: "external_bulk_mutation",
  invoice: "financial_action",
  refund: "financial_action",
  charge: "financial_action",
  payment: "financial_action",
  change_plan: "financial_action",
  share: "access_grant_or_revoke",
  grant_access: "access_grant_or_revoke",
  revoke_access: "access_grant_or_revoke",
  add_user: "access_grant_or_revoke",
  publish: "external_publish",
  create_public_link: "external_publish",
  make_public: "external_publish",
  rotate_credential: "credential_or_connection_change",
  revoke_connection: "credential_or_connection_change",
  rotate_key: "credential_or_connection_change",
  revoke_key: "credential_or_connection_change",
});

/**
 * Provider-specific writes that only ever create a new private file. Keyed by
 * provider because the guarantee is the executor's, not the verb's: the same
 * operation name on another provider fails closed.
 */
const NEW_PRIVATE_COPY_OPERATIONS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  microsoft: new Set(["upload_new"]),
});

/** Message-shaped operations — destructive only when the recipient is external. */
const MESSAGE_OPERATIONS: ReadonlySet<string> = new Set(["send", "message", "email"]);

const SAFE_READ: ClassifyActionResult = Object.freeze({ class: "safe_read", destructive: false });
const NEW_PRIVATE_COPY: ClassifyActionResult = Object.freeze({
  class: "new_private_copy",
  destructive: false,
});
const UNCLASSIFIED: ClassifyActionResult = Object.freeze({
  class: "unclassified_write",
  destructive: true,
});

function destructive(key: DestructiveActionClassKey): ClassifyActionResult {
  return { class: key, destructive: true };
}

/**
 * Place an action into a destructive class, a safe read, or the fail-closed
 * catch-all. Never throws — an unknown provider, operation, or task class is
 * classified as `unclassified_write` (destructive), never silently allowed.
 */
export function classifyAction(input: ClassifyActionInput): ClassifyActionResult {
  if (input.kind === "bridge") {
    const taskClass = input.taskClass.trim().toLowerCase();
    if (taskClass === "read") return SAFE_READ;
    if (taskClass === "act") return destructive("local_machine_mutation");
    // Any other bridge task class is write-shaped and unrecognized → fail closed.
    return UNCLASSIFIED;
  }

  const operation = input.operation.trim().toLowerCase();

  if (READ_OPERATIONS.has(operation)) return SAFE_READ;

  const provider = input.provider.trim().toLowerCase();
  if (NEW_PRIVATE_COPY_OPERATIONS[provider]?.has(operation)) return NEW_PRIVATE_COPY;

  if (MESSAGE_OPERATIONS.has(operation)) {
    // Internal messages (to the steward or an internal teammate) are safe;
    // anything else — including an unqualified recipient — is treated as
    // reaching outside the company.
    return input.recipientScope === "internal"
      ? SAFE_READ
      : destructive("outbound_external_message");
  }

  const named = OPERATION_CLASS[operation];
  if (named) return destructive(named);

  // Write-shaped and unplaceable → fail closed.
  return UNCLASSIFIED;
}
