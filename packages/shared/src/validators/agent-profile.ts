import { z } from "zod";
import { agentAccessPolicySchema } from "../agent-access-v2.js";
import {
  evaluationResponsibilityContractSchema,
  type EvaluationResponsibilityContract,
} from "../evaluation.js";
import { AGENT_ACCESS_V2_DIMENSIONS } from "../types/agent-governance.js";
import {
  AGENT_ACCESS_ENFORCEMENT_MODES,
  AGENT_PROFILE_FIELD_AUTHORITIES,
} from "../types/agent-profile.js";

/**
 * AgentDash: Agent Performance Management gate 2 — the operating profile.
 *
 * `AgentOperatingProfileV1` (overview LLD §3.1) is structured JSON with a
 * Markdown export. Each responsibility has a stable `key`; obligations bind
 * EXISTING routine triggers, deliverables and goals and never create them.
 * The provenance map is stored beside the body, keyed by JSON pointer.
 *
 * Also here, pure and dependency-free so server and UI agree byte for byte:
 * `profileBodyHash` (the `If-Match` value) and `diffProfiles` (the per-field
 * JSON-pointer diff carried in the approval payload).
 */

// ---------------------------------------------------------------------------
// Profile body
// ---------------------------------------------------------------------------

export const AGENT_PROFILE_VERSION = 1 as const;

/** Lowercase slug: letters, digits, `-` and `_`. Matches the derived revision 0 keys. */
export const AGENT_PROFILE_RESPONSIBILITY_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const shortText = z.string().trim().max(200);
const longText = z.string().trim().max(4000);
const responsibilityKeySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(AGENT_PROFILE_RESPONSIBILITY_KEY_PATTERN, "use lowercase letters, digits, '-' and '_'");

/** Drafts may leave descriptive text empty; provenance marks it `missing`. Ids, keys and bindings are validated. */
export const agentProfileIdentitySchema = z
  .object({
    name: shortText.min(1),
    title: shortText,
    summary: longText,
    audience: longText,
    style: z
      .object({
        tone: longText,
        uncertaintyRule: longText,
        example: longText.optional(),
      })
      .strict(),
  })
  .strict();

export const AGENT_PROFILE_OBLIGATION_KINDS = ["routine", "deliverable", "assigned", "goal"] as const;
export type AgentProfileObligationKind = (typeof AGENT_PROFILE_OBLIGATION_KINDS)[number];

/** Binds an existing record. `routine` needs a trigger, `deliverable` a deliverable, `goal` a goal; `assigned` binds nothing. */
export const agentProfileObligationSchema = z
  .object({
    kind: z.enum(AGENT_PROFILE_OBLIGATION_KINDS),
    routineTriggerId: z.string().uuid().optional(),
    deliverableId: z.string().uuid().optional(),
    goalId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const required = { routine: "routineTriggerId", deliverable: "deliverableId", goal: "goalId", assigned: null } as const;
    const field = required[value.kind];
    if (field && !value[field]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `a ${value.kind} obligation must name ${field}` });
    }
    for (const other of ["routineTriggerId", "deliverableId", "goalId"] as const) {
      if (other !== field && value[other]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [other], message: `${other} does not apply to a ${value.kind} obligation` });
      }
    }
  });

const principalRefShape = {
  userId: z.string().min(1).optional(),
  agentId: z.string().uuid().optional(),
};

/** Re-exported under the profile's name; the canonical schema lives with the evaluation vocabulary. */
export const responsibilityContractSchema = evaluationResponsibilityContractSchema;
export type ResponsibilityContract = EvaluationResponsibilityContract;

export const agentProfileResponsibilitySchema = z
  .object({
    key: responsibilityKeySchema,
    title: shortText.min(1),
    outcome: longText,
    notOwned: z.array(shortText.min(1)).max(50).optional(),
    stakeholders: z
      .array(z.object({ ...principalRefShape, need: longText }).strict())
      .max(50),
    obligation: agentProfileObligationSchema,
    deliverable: z.object({ what: longText, destination: shortText }).strict(),
    escalation: z
      .object({
        toUserId: z.string().min(1).optional(),
        toAgentId: z.string().uuid().optional(),
        when: longText,
      })
      .strict(),
    performance: responsibilityContractSchema,
  })
  .strict();
export type AgentProfileResponsibility = z.infer<typeof agentProfileResponsibilitySchema>;

export const AGENT_PROFILE_KNOWLEDGE_KINDS = ["company_fact", "document", "connection", "other"] as const;

export const agentProfileKnowledgeSchema = z
  .object({
    source: shortText.min(1),
    kind: z.enum(AGENT_PROFILE_KNOWLEDGE_KINDS),
    ref: shortText.optional(),
    freshness: shortText.optional(),
  })
  .strict();

export const agentProfileRhythmSchema = z
  .object({
    timezone: shortText.min(1),
    quietHours: shortText.optional(),
    reportTo: z.object(principalRefShape).strict(),
    reportCadence: shortText.optional(),
  })
  .strict();

/** Admin-authority fields (overview LLD §4.1): they carry host-executed settings. */
export const agentProfileRuntimeSchema = z
  .object({
    adapterType: shortText.min(1).optional(),
    model: shortText.min(1).optional(),
    environmentId: z.string().uuid().optional(),
    heartbeat: z
      .object({
        intervalSec: z.number().int().nonnegative().max(7 * 24 * 60 * 60).optional(),
        wakeOnDemand: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const agentOperatingProfileV1Schema = z
  .object({
    profileVersion: z.literal(AGENT_PROFILE_VERSION),
    identity: agentProfileIdentitySchema,
    responsibilities: z
      .array(agentProfileResponsibilitySchema)
      .max(50)
      .refine((items) => new Set(items.map((item) => item.key)).size === items.length, {
        message: "responsibility keys must be unique",
      }),
    knowledge: z.array(agentProfileKnowledgeSchema).max(100),
    /** Company skill keys it knows how to use; application installs `skills ∩ access.do.skills`. */
    skills: z.array(shortText.min(1)).max(200),
    /** The requested access (the request side). Admins set the ceiling separately. */
    access: agentAccessPolicySchema,
    rhythm: agentProfileRhythmSchema,
    runtime: agentProfileRuntimeSchema.optional(),
  })
  .strict();
export type AgentOperatingProfileV1 = z.infer<typeof agentOperatingProfileV1Schema>;

// ---------------------------------------------------------------------------
// Provenance and source references
// ---------------------------------------------------------------------------

/** RFC 6901 JSON pointer: "" (the whole document) or `/a/b/0`, with `~0` / `~1` escapes. */
export const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)*$/;
export const jsonPointerSchema = z.string().max(500).regex(JSON_POINTER_PATTERN, "must be a JSON pointer");

/**
 * Where a field's value came from. `setup_verified` is computed on read from
 * live state and is never stored as truth, so the stored map rejects it.
 */
export const AGENT_PROFILE_PROVENANCE_STATES = [
  "from_brief",
  "proposed",
  "owner_confirmed",
  "setup_verified",
  "missing",
] as const;
export type AgentProfileProvenanceState = (typeof AGENT_PROFILE_PROVENANCE_STATES)[number];
export const AGENT_PROFILE_STORED_PROVENANCE_STATES = ["from_brief", "proposed", "owner_confirmed", "missing"] as const;
export type AgentProfileStoredProvenanceState = (typeof AGENT_PROFILE_STORED_PROVENANCE_STATES)[number];

export const agentProfileProvenanceEntrySchema = z
  .object({
    state: z.enum(AGENT_PROFILE_STORED_PROVENANCE_STATES),
    /** e.g. `plan_card:<cardId>`, `agent.title`, `routine:<id>`, `brief:<documentId>`. */
    sourceRef: z.string().max(300).optional(),
    /** `user:<id>` or `agent:<id>`. */
    by: z.string().max(200).optional(),
    at: z.string().datetime().optional(),
  })
  .strict();
export type AgentProfileProvenanceEntry = z.infer<typeof agentProfileProvenanceEntrySchema>;

export const agentProfileProvenanceMapSchema = z
  .record(jsonPointerSchema, agentProfileProvenanceEntrySchema)
  .refine((map) => Object.keys(map).length <= 2000, { message: "too many provenance entries" });
export type AgentProfileProvenanceMap = z.infer<typeof agentProfileProvenanceMapSchema>;

/** What a revision drew on (plan card, brief, enrollment, ledger events). */
export const agentProfileSourceRefSchema = z
  .object({
    kind: z.enum(["plan_card", "brief", "workforce_enrollment", "agent_record", "ledger_event", "evaluation_card", "other"]),
    id: z.string().min(1).max(200),
    version: z.union([z.string().max(100), z.number()]).optional(),
    label: z.string().max(200).optional(),
  })
  .strict();
export type AgentProfileSourceRef = z.infer<typeof agentProfileSourceRefSchema>;

// ---------------------------------------------------------------------------
// Canonical hash
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped, Dates as
 * ISO strings. The same rule as the evaluator ledger's `canonicalJson`, so a
 * server `sha256(canonicalJson(body))` equals `profileBodyHash(body)`.
 */
export function canonicalProfileJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined) continue;
      out[key] = sortKeysDeep(member);
    }
    return out;
  }
  return value;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256 of a UTF-8 string, hex. A small synchronous implementation because
 * this module is shared with the browser bundle, where `node:crypto` is not
 * available and WebCrypto is async. Not for secrets — only for content hashes.
 */
function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * The profile body's content hash: hex SHA-256 of its canonical JSON. Stable
 * across key order and `undefined` members; any value change changes it. It is
 * the `If-Match` value for draft saves and the freeze check at application.
 */
export function profileBodyHash(body: AgentOperatingProfileV1): string {
  return sha256Hex(canonicalProfileJson(body));
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export const AGENT_PROFILE_DIFF_OPS = ["add", "remove", "replace", "reorder"] as const;
export type AgentProfileDiffOp = (typeof AGENT_PROFILE_DIFF_OPS)[number];

export interface AgentProfileDiffEntry {
  op: AgentProfileDiffOp;
  /**
   * JSON pointer. `add` and `replace` point into `b`; `remove` points into
   * `a`. `reorder` points at a keyed array whose members are unchanged but
   * whose order changed; `before` / `after` are then the key orders.
   */
  pointer: string;
  before?: unknown;
  after?: unknown;
  /**
   * For a member of a keyed array (responsibilities) and every entry inside
   * one (`/responsibilities/2/outcome`): that member's `key`, so a reader can
   * name it without the body.
   */
  key?: string;
  /** With `key`: the member's `title` when it has one (`b`'s; `a`'s for a removed member), for labels like Responsibility “Weekly pipeline report”. */
  title?: string;
}

export const agentProfileDiffEntrySchema = z
  .object({
    op: z.enum(AGENT_PROFILE_DIFF_OPS),
    pointer: jsonPointerSchema,
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    key: z.string().optional(),
    title: z.string().optional(),
  })
  .strict();

function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalProfileJson(a) === canonicalProfileJson(b);
}

function keyedMembers(values: unknown[]): string[] | null {
  if (values.length === 0) return null;
  const keys: string[] = [];
  for (const value of values) {
    if (!isPlainObject(value) || typeof value.key !== "string") return null;
    keys.push(value.key);
  }
  return new Set(keys).size === keys.length ? keys : null;
}

/** The keyed-array member an entry sits in: its `key`, and its `title` when it has one. */
interface DiffMember {
  key: string;
  title?: string;
}

function memberOf(value: Record<string, unknown>, key: string): DiffMember {
  return typeof value.title === "string" && value.title !== "" ? { key, title: value.title } : { key };
}

function diffValues(a: unknown, b: unknown, pointer: string, out: AgentProfileDiffEntry[], member?: DiffMember): void {
  if (a === undefined && b === undefined) return;
  if (a === undefined) {
    out.push({ op: "add", pointer, after: b, ...member });
    return;
  }
  if (b === undefined) {
    out.push({ op: "remove", pointer, before: a, ...member });
    return;
  }
  if (sameValue(a, b)) return;

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const field of keys) diffValues(a[field], b[field], `${pointer}/${escapePointerToken(field)}`, out, member);
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    // AgentDash (APM gate 2, P2.7): an empty side takes the other side's
    // shape, so adding the first responsibility (an agent whose derived
    // revision 0 has none) or removing the last one still names it.
    const aKeys = a.length === 0 ? (keyedMembers(b) ? [] : null) : keyedMembers(a);
    const bKeys = b.length === 0 ? (keyedMembers(a) ? [] : null) : keyedMembers(b);
    if (aKeys && bKeys) {
      diffKeyedArrays(a as Array<Record<string, unknown>>, b as Array<Record<string, unknown>>, aKeys, bKeys, pointer, out);
      return;
    }
    const containsObjects = [...a, ...b].some((value) => typeof value === "object" && value !== null);
    if (containsObjects) {
      const length = Math.max(a.length, b.length);
      for (let index = 0; index < length; index++) {
        diffValues(index < a.length ? a[index] : undefined, index < b.length ? b[index] : undefined, `${pointer}/${index}`, out, member);
      }
      return;
    }
    // A list of plain values (skills, ids, notOwned) is one field: replaced whole.
  }

  out.push({ op: "replace", pointer, before: a, after: b, ...member });
}

function diffKeyedArrays(
  a: Array<Record<string, unknown>>,
  b: Array<Record<string, unknown>>,
  aKeys: string[],
  bKeys: string[],
  pointer: string,
  out: AgentProfileDiffEntry[],
): void {
  const aIndex = new Map(aKeys.map((key, index) => [key, index]));
  const bSet = new Set(bKeys);
  aKeys.forEach((key, index) => {
    if (!bSet.has(key)) out.push({ op: "remove", pointer: `${pointer}/${index}`, before: a[index], ...memberOf(a[index], key) });
  });
  bKeys.forEach((key, index) => {
    const from = aIndex.get(key);
    if (from === undefined) {
      out.push({ op: "add", pointer: `${pointer}/${index}`, after: b[index], ...memberOf(b[index], key) });
      return;
    }
    // Every entry inside a kept member names it, so a label never needs the body.
    const member = memberOf(b[index], key);
    const fields = [...new Set([...Object.keys(a[from]), ...Object.keys(b[index])])].sort();
    for (const field of fields) {
      diffValues(a[from][field], b[index][field], `${pointer}/${index}/${escapePointerToken(field)}`, out, member);
    }
  });
  const keptA = aKeys.filter((key) => bSet.has(key));
  const keptB = bKeys.filter((key) => aIndex.has(key));
  if (keptA.join("\u0000") !== keptB.join("\u0000")) {
    out.push({ op: "reorder", pointer, before: keptA, after: keptB });
  }
}

/**
 * Per-field diff from `a` to `b` as JSON-pointer entries (overview LLD §4.1,
 * computed server-side into the approval payload). Objects are compared member
 * by member; arrays whose members all carry a unique `key` (responsibilities)
 * are aligned by key, so a reorder is one `reorder` entry rather than a cascade
 * of replacements; other arrays of objects are compared by index; arrays of
 * plain values are one field. Every entry for or inside a keyed member carries
 * the member's `key` and `title`. Output order is deterministic. `a` may be
 * null (a first profile), in which case the whole body is one `add` at "".
 */
export function diffProfiles(a: AgentOperatingProfileV1 | null, b: AgentOperatingProfileV1): AgentProfileDiffEntry[] {
  const out: AgentProfileDiffEntry[] = [];
  if (a === null) return [{ op: "add", pointer: "", after: b }];
  diffValues(a, b, "", out);
  return out;
}

// ---------------------------------------------------------------------------
// Pure lookups the server packages share
// ---------------------------------------------------------------------------

export function profileResponsibilityKeys(body: AgentOperatingProfileV1): string[] {
  return body.responsibilities.map((responsibility) => responsibility.key);
}

export function findProfileResponsibility(body: AgentOperatingProfileV1, key: string): AgentProfileResponsibility | null {
  return body.responsibilities.find((responsibility) => responsibility.key === key) ?? null;
}

/** The responsibility a routine trigger is bound to, if any (routine dispatch writes the mapping row). */
export function findResponsibilityByRoutineTrigger(
  body: AgentOperatingProfileV1,
  routineTriggerId: string,
): AgentProfileResponsibility | null {
  return (
    body.responsibilities.find(
      (responsibility) =>
        responsibility.obligation.kind === "routine" && responsibility.obligation.routineTriggerId === routineTriggerId,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Route bodies (overview LLD §5; gate 2 spec P2.2–P2.4)
// ---------------------------------------------------------------------------

/**
 * `POST /api/companies/:companyId/agents/:agentId/profile/revisions`. With no
 * `body` the server seeds the draft from the active revision, or from derived
 * revision 0 with `proposed` provenance.
 */
export const createAgentProfileDraftSchema = z
  .object({
    body: agentOperatingProfileV1Schema.optional(),
    provenance: agentProfileProvenanceMapSchema.optional(),
    sourceRefs: z.array(agentProfileSourceRefSchema).max(50).optional(),
  })
  .strict();
export type CreateAgentProfileDraft = z.infer<typeof createAgentProfileDraftSchema>;

/** `PATCH .../profile/revisions/:revisionId` with header `If-Match: <bodyHash>`. */
export const updateAgentProfileDraftSchema = z
  .object({
    body: agentOperatingProfileV1Schema,
    provenance: agentProfileProvenanceMapSchema.optional(),
    sourceRefs: z.array(agentProfileSourceRefSchema).max(50).optional(),
  })
  .strict();
export type UpdateAgentProfileDraft = z.infer<typeof updateAgentProfileDraftSchema>;

/** `POST .../profile/revisions/:revisionId/propose`. */
export const proposeAgentProfileRevisionSchema = z
  .object({
    reason: longText.optional(),
    expectedBenefit: longText.optional(),
    risks: longText.optional(),
    evidence: z
      .object({
        cardId: z.string().min(1).optional(),
        cardVersion: z.number().int().positive().optional(),
        ledgerEventIds: z.array(z.string().min(1)).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProposeAgentProfileRevision = z.infer<typeof proposeAgentProfileRevisionSchema>;

/** `POST .../profile/revisions/:revisionId/withdraw`, while the approval is pending. */
export const withdrawAgentProfileRevisionSchema = z.object({ reason: longText.optional() }).strict();
export type WithdrawAgentProfileRevision = z.infer<typeof withdrawAgentProfileRevisionSchema>;

/** `POST /api/companies/:companyId/issues/:issueId/responsibility`. */
export const mapIssueResponsibilitySchema = z
  .object({
    agentId: z.string().uuid(),
    responsibilityKey: responsibilityKeySchema,
    reason: longText.optional(),
  })
  .strict();
export type MapIssueResponsibility = z.infer<typeof mapIssueResponsibilitySchema>;

/**
 * `PATCH /api/companies/:companyId/agent-access-enforcement`. All three modes
 * parse so the route can answer `enforce` with 409 "available in gate 3"
 * rather than a 400.
 */
export const updateAgentAccessEnforcementSchema = z
  .object({ mode: z.enum(AGENT_ACCESS_ENFORCEMENT_MODES) })
  .strict();
export type UpdateAgentAccessEnforcement = z.infer<typeof updateAgentAccessEnforcementSchema>;

// ---------------------------------------------------------------------------
// Approval payload
// ---------------------------------------------------------------------------

const v2DimensionOrV1Field = z.union([
  z.enum(AGENT_ACCESS_V2_DIMENSIONS),
  z.enum(["permissions", "monthlyBudgetCents", "destructiveActions", "dataScopes", "providers", "minimumApproval"]),
]);

/**
 * The `agent_profile_change` approval payload (`AgentProfileChangePayload`).
 * The server writes it at propose time; renderers and the application read it
 * back through this schema. It is never accepted from a client as-is: the
 * application re-reads the frozen revision and checks `bodyHash`.
 */
export const agentProfileChangePayloadSchema = z
  .object({
    agentId: z.string().uuid(),
    profileId: z.string().uuid(),
    revisionId: z.string().uuid(),
    revisionNumber: z.number().int().positive(),
    basedOnRevisionId: z.string().uuid().nullable(),
    bases: z
      .object({
        basedOnRevisionId: z.string().uuid().nullable(),
        governanceRevision: z.number().int().positive().nullable(),
        configRevisionId: z.string().uuid().nullable(),
      })
      .strict(),
    bodyHash: z.string().regex(/^[0-9a-f]{64}$/),
    diff: z.array(agentProfileDiffEntrySchema),
    fieldAuthority: z.array(
      z
        .object({
          pointer: jsonPointerSchema,
          required: z.enum(AGENT_PROFILE_FIELD_AUTHORITIES),
          reason: z.string().nullable().optional(),
        })
        .strict(),
    ),
    requiredAuthority: z.enum(AGENT_PROFILE_FIELD_AUTHORITIES),
    affectedResponsibilities: z.array(z.string()),
    accessChanges: z.array(
      z
        .object({
          dimension: v2DimensionOrV1Field,
          change: z.enum(["widens", "narrows", "changes"]),
          clippedByCeiling: z.boolean(),
          clip: z
            .object({
              dimension: z.enum(AGENT_ACCESS_V2_DIMENSIONS),
              detail: z.string(),
              values: z.array(z.string()).optional(),
              incomparable: z.boolean().optional(),
            })
            .strict()
            .nullable()
            .optional(),
          detail: z.string().nullable().optional(),
        })
        .strict(),
    ),
    evidence: z
      .object({
        cardId: z.string().nullable().optional(),
        cardVersion: z.number().int().nullable().optional(),
        ledgerEventIds: z.array(z.string()),
      })
      .strict(),
    reason: z.string().nullable(),
    expectedBenefit: z.string().nullable(),
    risks: z.string().nullable(),
    proposedBy: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("agent"),
          agentId: z.string().uuid(),
          runId: z.string().nullable().optional(),
          // AgentDash (APM gate 4): the performance manager filed it; a label, never an authority.
          capacity: z.literal("performance_manager").optional(),
        })
        .strict(),
      z.object({ kind: z.literal("user"), userId: z.string().min(1) }).strict(),
    ]),
  })
  .strict();
