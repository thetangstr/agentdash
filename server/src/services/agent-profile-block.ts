import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentProfileRevisions, agentProfiles } from "@paperclipai/db";
import {
  agentOperatingProfileV1Schema,
  type AgentAccessContactScope,
  type AgentAccessListScope,
  type AgentOperatingProfileV1,
  type AgentProfileDeliveryEvidence,
} from "@paperclipai/shared";
import { agentInstructionsService } from "./agent-instructions.js";

/**
 * AgentDash: Agent Performance Management gate 2 — the operating-profile block
 * in the agent's managed AGENTS.md (overview LLD §3.4; gate 2 spec P2.2).
 *
 * The block uses the named-block convention the instruction refresh already
 * parses:
 *   <!-- AgentDash: operating-profile rev=<n> hash=<h> -->
 *   ...
 *   <!-- /AgentDash: operating-profile -->
 *
 * It carries DATA only — duties, what the agent does not own, deliverables,
 * escalation, style and a plain access summary — rendered from the agent's
 * ACTIVE revision. The static agent guidance lives in a separate default-bundle
 * block (`operating-profile-guidance`, P2.4). `agent-instruction-refresh`
 * sources this slug from the active revision only, never from the default
 * bundle, and never deletes it because the default bundle lacks it.
 *
 * Delivery is best-effort, so it is evidenced at run start
 * (`profileDeliveryEvidence`, written by P2.3), never assumed.
 */

/** The named-block slug of the rendered per-agent block. */
export const OPERATING_PROFILE_BLOCK_SLUG = "operating-profile";

export interface ProfileBlockRevision {
  id: string;
  revisionNumber: number;
  body: AgentOperatingProfileV1;
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

/**
 * Profile text is written by people and agents. It must never be able to close
 * the block early or open a second one, so HTML comment delimiters are
 * neutralized and line breaks in one-line fields are folded.
 */
function inline(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim();
}

function principal(ref: { userId?: string; agentId?: string } | undefined): string | null {
  if (!ref) return null;
  if (ref.agentId) return `agent ${ref.agentId}`;
  if (ref.userId) return `person ${ref.userId}`;
  return null;
}

function listScopeSummary(scope: AgentAccessListScope | undefined, noun: string): string | null {
  if (!scope) return null;
  if (scope.mode === "all") return `all ${noun}s`;
  if (scope.ids.length === 0) return `no ${noun}s`;
  return `${scope.ids.length} listed ${noun}${scope.ids.length === 1 ? "" : "s"} (${scope.ids.map(inline).join(", ")})`;
}

function contactSummary(scope: AgentAccessContactScope | undefined, noun: string): string | null {
  if (!scope) return null;
  switch (scope.mode) {
    case "any":
      return `any ${noun}`;
    case "reports_chain":
      return "its reporting line and direct reports";
    case "accountable_only":
      return "its accountable person, steward and company admins only";
    case "listed": {
      const ids = [...(scope.agentIds ?? []), ...(scope.userIds ?? [])];
      return ids.length === 0 ? `no listed ${noun}s` : `listed ${noun}s (${ids.map(inline).join(", ")})`;
    }
  }
}

function accessSummaryLines(access: AgentOperatingProfileV1["access"]): string[] {
  const lines: string[] = [];
  const see: string[] = [];
  const projects = listScopeSummary(access.see?.projects, "project");
  if (projects) see.push(`projects: ${projects}`);
  if (access.see?.connections) {
    see.push(
      access.see.connections.length === 0
        ? "connections: none"
        : `connections: ${access.see.connections
            .map((entry) => `${entry.connectionId} (${entry.dataScopes.includes("*") ? "all data" : entry.dataScopes.join(", ")})`)
            .join("; ")}`,
    );
  }
  lines.push(`- See: ${see.length > 0 ? see.join("; ") : "not limited by this profile"}`);

  const doParts: string[] = [];
  const skills = listScopeSummary(access.do?.skills, "skill");
  if (skills) doParts.push(`skills: ${skills}`);
  if (access.do?.connections) {
    doParts.push(
      access.do.connections.length === 0
        ? "connection actions: none"
        : `connection actions: ${access.do.connections
            .map((entry) => `${entry.connectionId} (draft ${entry.draft}, send ${entry.send})`)
            .join("; ")}`,
    );
  }
  doParts.push(`destructive actions: ${access.destructiveActions.replace(/_/g, " ")}`);
  lines.push(`- Do: ${doParts.join("; ")}`);

  const talk: string[] = [];
  const agentsReach = contactSummary(access.talk?.agents, "agent");
  if (agentsReach && access.talk?.agents) talk.push(`agents: ${agentsReach} (via ${access.talk.agents.via.join(", ") || "nothing"})`);
  const people = contactSummary(access.talk?.people, "person");
  if (people) talk.push(`people: ${people}`);
  if (access.talk?.external) {
    talk.push(
      access.talk.external.length === 0
        ? "external: nobody"
        : `external: ${access.talk.external
            .map((entry) =>
              entry.targets.mode === "any"
                ? `${entry.connectionId} (anyone)`
                : `${entry.connectionId} (${entry.targets.mode}: ${entry.targets.values.map(inline).join(", ") || "none"})`,
            )
            .join("; ")}`,
    );
  }
  const inbound = contactSummary(access.talk?.inbound, "agent");
  if (inbound) talk.push(`who may reach it: ${inbound}`);
  lines.push(`- Talk: ${talk.length > 0 ? talk.join("; ") : "not limited by this profile"}`);
  lines.push("- Your escalation path to your accountable person is always open.");
  return lines;
}

function obligationLine(obligation: AgentOperatingProfileV1["responsibilities"][number]["obligation"]): string {
  switch (obligation.kind) {
    case "routine":
      return `routine trigger ${obligation.routineTriggerId}`;
    case "deliverable":
      return `deliverable ${obligation.deliverableId}`;
    case "goal":
      return `goal ${obligation.goalId}`;
    case "assigned":
      return "work assigned to you";
  }
}

/** The text between the markers. Deterministic for a given body and revision number. */
function renderProfileBlockBody(revision: ProfileBlockRevision): string {
  const { body } = revision;
  const lines: string[] = [];
  lines.push(`## Operating profile (revision ${revision.revisionNumber})`);
  lines.push("");
  const heading = [inline(body.identity.name), inline(body.identity.title)].filter(Boolean).join(" — ");
  lines.push(`**${heading}**`);
  if (inline(body.identity.summary)) lines.push(`Summary: ${inline(body.identity.summary)}`);
  if (inline(body.identity.audience)) lines.push(`Audience: ${inline(body.identity.audience)}`);
  lines.push("");

  lines.push("### Duties");
  if (body.responsibilities.length === 0) {
    lines.push("No duties are defined yet.");
  }
  for (const responsibility of body.responsibilities) {
    lines.push("");
    lines.push(`#### ${inline(responsibility.title)} (\`${responsibility.key}\`)`);
    if (inline(responsibility.outcome)) lines.push(`- Outcome: ${inline(responsibility.outcome)}`);
    lines.push(`- Owed through: ${obligationLine(responsibility.obligation)}`);
    if (inline(responsibility.deliverable.what) || inline(responsibility.deliverable.destination)) {
      lines.push(
        `- Deliverable: ${inline(responsibility.deliverable.what) || "unspecified"}${
          inline(responsibility.deliverable.destination) ? ` → ${inline(responsibility.deliverable.destination)}` : ""
        }`,
      );
    }
    const escalateTo = principal({ userId: responsibility.escalation.toUserId, agentId: responsibility.escalation.toAgentId });
    if (escalateTo || inline(responsibility.escalation.when)) {
      lines.push(
        `- Escalate${escalateTo ? ` to ${escalateTo}` : ""}${
          inline(responsibility.escalation.when) ? ` when: ${inline(responsibility.escalation.when)}` : ""
        }`,
      );
    }
  }
  lines.push("");

  lines.push("### Not yours");
  const notOwned = body.responsibilities.flatMap((responsibility) =>
    (responsibility.notOwned ?? []).map((item) => `- ${inline(item)} (from \`${responsibility.key}\`)`),
  );
  lines.push(...(notOwned.length > 0 ? notOwned : ["Nothing is listed."]));
  lines.push("");

  lines.push("### Style");
  lines.push(`- Tone: ${inline(body.identity.style.tone) || "not specified"}`);
  lines.push(`- When unsure: ${inline(body.identity.style.uncertaintyRule) || "not specified"}`);
  if (inline(body.identity.style.example)) lines.push(`- Example: ${inline(body.identity.style.example)}`);
  const reportTo = principal(body.rhythm.reportTo);
  if (reportTo) lines.push(`- Report to: ${reportTo}${inline(body.rhythm.reportCadence) ? ` (${inline(body.rhythm.reportCadence)})` : ""}`);
  lines.push("");

  lines.push("### Access (plain summary)");
  lines.push(...accessSummaryLines(body.access));
  return lines.join("\n");
}

/**
 * Hash of a block body (the text between the markers): hex SHA-256 after
 * normalizing line endings to `\n` and trimming surrounding whitespace, so a
 * re-save by an editor does not read as drift. Pure.
 */
export function profileBlockHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n?/g, "\n").trim(), "utf8").digest("hex");
}

/**
 * Render the whole named block, markers included. `hash` in the opening marker
 * is `profileBlockHash` of the body between the markers. Data only: the static
 * guidance is the default bundle's `operating-profile-guidance` block. Pure and
 * deterministic.
 *
 * AgentDash: P2.1 froze an optional `{ guidance }` parameter for embedding the
 * default bundle's guidance; the gate 2 orchestrator split that guidance into
 * its own block, so the parameter was removed.
 */
export function renderProfileBlock(revision: ProfileBlockRevision): string {
  const body = renderProfileBlockBody(revision);
  const hash = profileBlockHash(body);
  return [
    `<!-- AgentDash: ${OPERATING_PROFILE_BLOCK_SLUG} rev=${revision.revisionNumber} hash=${hash} -->`,
    body,
    `<!-- /AgentDash: ${OPERATING_PROFILE_BLOCK_SLUG} -->`,
  ].join("\n");
}

/** The hash `renderProfileBlock(revision)` carries — the expected on-disk hash. */
export function expectedProfileBlockHash(revision: ProfileBlockRevision): string {
  return profileBlockHash(renderProfileBlockBody(revision));
}

// `operating-profile` must not match the prefix of `operating-profile-guidance`,
// so the slug is followed by a lookahead rather than `\b` (a `-` is a boundary).
const PROFILE_BLOCK_REGEX = new RegExp(
  `<!--\\s*AgentDash:\\s*${OPERATING_PROFILE_BLOCK_SLUG}(?![\\w-])([^]*?)-->([\\s\\S]*?)<!--\\s*\\/AgentDash:\\s*${OPERATING_PROFILE_BLOCK_SLUG}\\s*-->`,
);

/**
 * Find the operating-profile block in an AGENTS.md text. Returns the revision
 * number and hash the marker CLAIMS, and the body actually present (hash it
 * with `profileBlockHash` to compare). Null when the block is absent. Pure.
 */
export function readProfileBlock(
  fileText: string,
): { revisionNumber: number | null; claimedHash: string | null; body: string } | null {
  const match = PROFILE_BLOCK_REGEX.exec(fileText);
  if (!match) return null;
  const attributes = match[1] ?? "";
  const rev = /\brev=(\d+)\b/.exec(attributes);
  const hash = /\bhash=([0-9a-f]{64})\b/.exec(attributes);
  return {
    revisionNumber: rev ? Number(rev[1]) : null,
    claimedHash: hash ? hash[1]! : null,
    body: (match[2] ?? "").replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The agent's active revision in the shape the block needs, or null when no
 * revision has been applied. Read-only; the instruction refresh and the
 * run-start evidence both read through this.
 */
export async function loadActiveProfileBlockRevision(
  db: Db,
  agent: { id: string; companyId: string },
): Promise<ProfileBlockRevision | null> {
  // Relational reads (`db.query`), two point lookups by unique key.
  const profile = await db.query.agentProfiles.findFirst({
    columns: { activeRevisionId: true },
    where: and(eq(agentProfiles.agentId, agent.id), eq(agentProfiles.companyId, agent.companyId)),
  });
  if (!profile?.activeRevisionId) return null;
  const row = await db.query.agentProfileRevisions.findFirst({
    columns: { id: true, revisionNumber: true, body: true },
    where: and(eq(agentProfileRevisions.id, profile.activeRevisionId), eq(agentProfileRevisions.companyId, agent.companyId)),
  });
  if (!row) return null;
  // The stored body was validated on every write; parse again so a hand-edited
  // row renders as "no block" rather than as a malformed one.
  const parsed = agentOperatingProfileV1Schema.safeParse(row.body);
  return parsed.success ? { id: row.id, revisionNumber: row.revisionNumber, body: parsed.data } : null;
}

export interface ProfileDeliveryEvidenceDeps {
  /** Reads the agent's AGENTS.md entry file; null when absent. Production uses the instructions service. */
  readAgentsMd?: (agent: { id: string; companyId: string; name: string; adapterConfig: unknown }) => Promise<string | null>;
}

/**
 * Run-start delivery evidence (written by P2.3 into `context_snapshot`): the
 * active revision, the hash of the block actually read from the agent's
 * instruction bundle on disk, and the hash the active revision renders to.
 * Never throws for an unreadable bundle: `blockHashOnDisk` is null instead.
 */
export async function profileDeliveryEvidence(
  db: Db,
  agent: { id: string; companyId: string; adapterType: string; adapterConfig: Record<string, unknown>; name?: string },
  deps: ProfileDeliveryEvidenceDeps = {},
): Promise<AgentProfileDeliveryEvidence> {
  let active: ProfileBlockRevision | null = null;
  try {
    active = await loadActiveProfileBlockRevision(db, agent);
  } catch {
    active = null;
  }
  const readAgentsMd =
    deps.readAgentsMd ??
    (async (target) => {
      const file = await agentInstructionsService().readFile(target, "AGENTS.md");
      return typeof file?.content === "string" ? file.content : null;
    });
  let blockHashOnDisk: string | null = null;
  try {
    const content = await readAgentsMd({
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name ?? agent.id,
      adapterConfig: agent.adapterConfig,
    });
    const block = content === null ? null : readProfileBlock(content);
    blockHashOnDisk = block ? profileBlockHash(block.body) : null;
  } catch {
    blockHashOnDisk = null;
  }
  return {
    profileRevisionId: active?.id ?? null,
    blockHashOnDisk,
    expectedHash: active ? expectedProfileBlockHash(active) : null,
  };
}
