import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, max, min, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { getClosedIsolatedExecutionWorkspaceMessage, isClosedIsolatedExecutionWorkspace } from "@paperclipai/shared";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companyMemberships,
  issueApprovals,
  issueThreadInteractions,
  issues,
  projects,
  stewardInboxActionHandles,
} from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  isProjectIdVisible,
  issueVisibilityCondition,
  projectVisibilityCondition,
  visibleAgentIdsFor,
} from "../routes/visibility.js";
import { accessService } from "./access.js";
import { logActivity } from "./activity-log.js";
import { agentAccountabilityService } from "./agent-accountability.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";
import { IssueCommentPolicyRefusal, isClosedIssueStatus } from "./issue-mutation-actions.js";
import { issuePatchActions, type IssuePatchContext } from "./issue-patch-actions.js";
import { issuePatchHooks, type IssuePatchHooks } from "./issue-patch-hooks.js";
import { issueReferenceService } from "./issue-references.js";
import { issueService } from "./issues.js";
import type { heartbeatService } from "./heartbeat.js";
import { DECIDABLE_STATUSES, activeMembership, frameUntrustedText, personRequest } from "./steward-inbox.js";
import { suggestNames } from "./steward-inbox-actions.js";
import {
  BRIDGE_WORK_REQUEST_ACCEPTED,
  isDeliveredToRequester,
  isOwnersRequest,
  ownersRequestCondition,
  requestedForUserIds,
} from "./steward-request-scope.js";
import { resolveStewardedAgentRoute, type StewardedAgentRoute } from "./stewarded-agent-routing.js";
import {
  isWorkRefusal,
  stewardWorkService,
  workRefusal,
  type StewardWorkOwner,
  type WorkRefusal,
} from "./steward-work.js";

/**
 * AgentDash-MK: the person's own Claude asks someone else for work, and closes
 * it out when the result comes back (co-worker slice 4).
 *
 * Intake. The person describes what they want; their Claude turns it into a
 * brief and reads it back (`propose`): title, what is wanted, what done means,
 * the deadline, who it is for, and the person it goes to. On their explicit
 * go the handle is spent (`confirm`) and the issue is created AS THEM,
 * assigned to that person. The existing stewarded-agent routing then gives it
 * to that person's agent, exactly as when the same issue is assigned on the
 * page. Authority is the page's: `tasks:assign`, a project both people can
 * see, and an agent the requester can see.
 *
 * Close-out. "Your requests" are listed beside the hand-offs (`list`), with
 * where each one is stuck and for how long, computed here so every client
 * says the same thing ("waiting on Person B for 2 days"). On a delivered
 * result the requester accepts it (done, as them) or asks for changes (a
 * comment as them, reopened, and handed straight to the deliverable owner's
 * agent: the agent of the person the request was asked of, O6/O7). A change
 * request is a correction signal for that agent (`recordRequesterChangeRequest`).
 *
 * Every write is one single-use handle bound to the endpoint, the owner, the
 * target and the exact payload read back, with authority re-checked when it
 * is spent. Refusals answer `{ ok: false, code, reason }`. Gated, like every
 * work route, by `bridge:work` and `coworker_bridge_enabled`.
 */

/** The handle kinds this service mints and spends. No other route spends them. */
export const REQUEST_HANDLE_KINDS = ["request_work", "request_accept", "request_changes"] as const;
export type RequestHandleKind = (typeof REQUEST_HANDLE_KINDS)[number];

/** As long as the other inbox action handles: enough to read a read-back. */
const HANDLE_TTL_MS = 15 * 60 * 1000;

export const REQUEST_BRIEF_CAPS = {
  title: 160,
  wanted: 8_000,
  doneMeans: 4_000,
  forWhom: 200,
  person: 200,
  project: 200,
  note: 4_000,
} as const;

export const REQUEST_LIMITS = {
  listDefault: 25,
  listMax: 50,
  digestItems: 5,
  /** A done result stays "delivered" this long unless the requester acts on it first. */
  deliveredWindowDays: 14,
  /** Candidate rows read per call; more says `truncated`. */
  scan: 500,
  /**
   * Candidate rows the session-start digest reads: it runs on every session
   * start, and says "at least" (`truncated`) when there are more.
   */
  digestScan: 100,
} as const;

/**
 * An owner action this close to the completion still counts as acting on the
 * result: `completed_at` is stamped in the application and the activity row by
 * the database, so the two clocks can differ by a moment.
 */
const ACK_CLOCK_SKEW_MS = 5_000;

/** How an agent the requester cannot see is named to them. */
export const HIDDEN_AGENT_LABEL = "an agent you cannot see";

/** The prefix of the comment a change request posts, read back word for word. */
export const CHANGE_REQUEST_COMMENT_PREFIX = "Changes requested on the delivered result.";

/** "2 days", "3 hours", "15 minutes": how long, in words a person says. */
export function waitedInWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "less than a minute";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** YYYY-MM-DD, a real calendar date. */
export function parseDeadline(value: unknown): { ok: true; date: string | null } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, date: null };
  if (typeof value !== "string") return { ok: false };
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return { ok: false };
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return { ok: false };
  return { ok: true, date: text };
}

/** The issue description a brief becomes. Plain markdown the agent reads first. */
export function composeRequestDescription(brief: {
  requesterName: string | null;
  wanted: string;
  doneMeans: string;
  forWhom: string | null;
  deadline: string | null;
}): string {
  const lines = [
    `Requested by ${brief.requesterName ?? "a colleague"}${brief.forWhom ? `, for ${brief.forWhom}` : ""}.`,
    ...(brief.deadline ? [`Deadline: ${brief.deadline}`] : []),
    "",
    "## What is wanted",
    "",
    brief.wanted,
    "",
    "## What done means",
    "",
    brief.doneMeans,
  ];
  return lines.join("\n");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type IssueRow = typeof issues.$inferSelect;
type PatchRuntime = Pick<ReturnType<typeof heartbeatService>, "wakeup" | "cancelRun" | "reportRunActivity">;
type Owner = StewardWorkOwner;

type HolderKind = "agent" | "person" | "you" | "nobody";

export interface RequestItem {
  issueId: string;
  identifier: string | null;
  title: string | null;
  status: string;
  requestedOf: string | null;
  delivered: boolean;
  /** Who has it now and why, and since when. */
  waitingOn: { kind: HolderKind; name: string | null; why: string };
  waitingSince: string;
  waitedSeconds: number;
  /** The whole state in one line, e.g. "waiting on Person B for 2 days (Agent B asked them a question)". */
  summary: string;
  doneAt: string | null;
}

/**
 * The correction signal for a requester's change request (O6). The learning
 * loop's shared helper (`recordAgentCorrection` in services/agent-corrections.ts,
 * co-worker slice 3) is not on this branch; this is the single call site it
 * replaces, and it records the signal on the issue in the meantime. The agent
 * is woken by the change request's own comment, which carries the summary.
 */
export async function recordRequesterChangeRequest(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    requesterUserId: string;
    commentId: string | null;
    previousStatus: string;
    previousAssigneeAgentId: string | null;
    channel: Record<string, unknown>;
  },
): Promise<void> {
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "user",
    actorId: input.requesterUserId,
    action: "issue.requester_changes_requested",
    entityType: "issue",
    entityId: input.issueId,
    agentId: input.agentId,
    details: {
      correction: "requester_change_request",
      deliverableOwnerAgentId: input.agentId,
      commentId: input.commentId,
      previousStatus: input.previousStatus,
      previousAssigneeAgentId: input.previousAssigneeAgentId,
      ...input.channel,
    },
  });
}

export function stewardRequestsService(
  db: Db,
  options: {
    /** Wakes on create and runs the issue update pipeline on close-out. */
    runtime?: PatchRuntime;
    /**
     * The issue update hooks the page's PATCH route passes (review queue,
     * telemetry), so a close-out here has the page's effects. Tests substitute them.
     */
    patchHooks?: IssuePatchHooks;
  } = {},
) {
  const work = stewardWorkService(db);
  const patchHooks = options.patchHooks ?? issuePatchHooks(db);
  const access = accessService(db);
  const accountability = agentAccountabilityService(db);

  function channelOf(owner: Owner) {
    return { channel: "bridge_work", bridgeEndpointId: owner.endpoint.id, endpointLabel: owner.endpoint.label };
  }

  async function userNames(ids: Array<string | null | undefined>) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    const out = new Map<string, string>();
    if (unique.length === 0) return out;
    for (const row of await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, unique))) {
      const name = frameUntrustedText(row.name, REQUEST_BRIEF_CAPS.person);
      if (name) out.set(row.id, name);
    }
    return out;
  }

  async function agentNames(ids: Array<string | null | undefined>) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    const out = new Map<string, string>();
    if (unique.length === 0) return out;
    for (const row of await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, unique))) {
      out.set(row.id, frameUntrustedText(row.name, REQUEST_BRIEF_CAPS.person) ?? "an agent");
    }
    return out;
  }

  /** The agent the routing rule would give this person's work to, if the requester can see it. */
  async function routeFor(owner: Owner, targetUserId: string): Promise<StewardedAgentRoute | null> {
    const routed = await resolveStewardedAgentRoute(db, {
      companyId: owner.companyId,
      actorAgentId: null,
      actorUserId: owner.userId,
      assigneeUserId: targetUserId,
    });
    if (!routed) return null;
    const visible = await visibleAgentIdsFor(db, owner.req, owner.companyId);
    if (visible !== null && !visible.has(routed.toAgentId)) return null;
    return routed;
  }

  async function mintHandle(owner: Owner, kind: RequestHandleKind, payload: Record<string, unknown>) {
    const token = randomBytes(32).toString("base64url");
    await db.insert(stewardInboxActionHandles).values({
      token,
      companyId: owner.companyId,
      bridgeEndpointId: owner.endpoint.id,
      actorUserId: owner.userId,
      kind,
      payload,
      expiresAt: new Date(Date.now() + HANDLE_TTL_MS),
    });
    return token;
  }

  /** Spend a request handle. Conditional UPDATE, so two confirmations cannot both win. */
  async function consume(token: string, owner: Owner) {
    const now = new Date();
    return db
      .update(stewardInboxActionHandles)
      .set({ consumedAt: now })
      .where(
        and(
          eq(stewardInboxActionHandles.token, token),
          eq(stewardInboxActionHandles.bridgeEndpointId, owner.endpoint.id),
          eq(stewardInboxActionHandles.companyId, owner.companyId),
          eq(stewardInboxActionHandles.actorUserId, owner.userId),
          inArray(stewardInboxActionHandles.kind, [...REQUEST_HANDLE_KINDS]),
          isNull(stewardInboxActionHandles.consumedAt),
          gt(stewardInboxActionHandles.expiresAt, now),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function mayAssign(owner: Owner, reader: Db = db) {
    return accessService(reader).canUser(owner.companyId, owner.userId, "tasks:assign");
  }

  const NOT_PERMITTED =
    "You do not have permission to assign work in this company, so you cannot ask a colleague for it from here or on the page. Nothing was sent.";

  // -------------------------------------------------------------------------
  // Intake: propose a request
  // -------------------------------------------------------------------------

  async function activeMembers(companyId: string) {
    return db
      .select({
        userId: authUsers.id,
        name: authUsers.name,
        email: authUsers.email,
        membershipRole: companyMemberships.membershipRole,
        status: companyMemberships.status,
      })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      );
  }

  async function propose(endpointId: string, input: Record<string, unknown>) {
    const owner = await work.resolveOwner(endpointId);
    if (isWorkRefusal(owner)) return owner;

    // Files with a request arrive with file transport (co-worker slice 5).
    if (Array.isArray(input.files) && input.files.length > 0) {
      return workRefusal(
        "files_not_supported_yet",
        "Files cannot travel with a request from here yet. Describe them in the brief, or attach them on the issue page once it exists. Nothing was proposed.",
      );
    }

    const title = str(input.title).replace(/\s+/g, " ");
    const wanted = str(input.wanted);
    const doneMeans = str(input.doneMeans);
    const forWhom = str(input.forWhom).replace(/\s+/g, " ") || null;
    const personGiven = str(input.person).replace(/\s+/g, " ");
    const projectGiven = str(input.project).replace(/\s+/g, " ") || null;

    const missing = [
      ...(title ? [] : ["a title"]),
      ...(wanted ? [] : ["what is wanted"]),
      ...(doneMeans ? [] : ["what done means"]),
      ...(personGiven ? [] : ["the person it goes to"]),
    ];
    if (missing.length > 0) {
      return workRefusal("incomplete_brief", `A request needs ${missing.join(", ")}. Ask the person, then propose again.`);
    }
    for (const [field, value, cap] of [
      ["The title", title, REQUEST_BRIEF_CAPS.title],
      ["What is wanted", wanted, REQUEST_BRIEF_CAPS.wanted],
      ["What done means", doneMeans, REQUEST_BRIEF_CAPS.doneMeans],
      ["Who it is for", forWhom ?? "", REQUEST_BRIEF_CAPS.forWhom],
      ["The person", personGiven, REQUEST_BRIEF_CAPS.person],
      ["The project", projectGiven ?? "", REQUEST_BRIEF_CAPS.project],
    ] as const) {
      if (value.length > cap) {
        return workRefusal("too_long", `${field} is over ${cap.toLocaleString("en-US")} characters. Shorten it, or put the long material in a document on the issue once it exists.`);
      }
    }
    const deadline = parseDeadline(input.deadline);
    if (!deadline.ok) {
      return workRefusal("bad_deadline", "Give the deadline as a calendar date, like 2026-10-20, or leave it out.");
    }

    if (!(await mayAssign(owner))) return workRefusal("not_permitted", NOT_PERMITTED);

    // The person: an exact name or email among the company's active members.
    const members = await activeMembers(owner.companyId);
    const wantedName = normalizeName(personGiven);
    const matches = members.filter(
      (member) =>
        (member.name && normalizeName(member.name) === wantedName) ||
        (member.email && member.email.trim().toLowerCase() === wantedName),
    );
    if (matches.length !== 1) {
      const names = [...new Set(members.map((member) => member.name).filter((name): name is string => Boolean(name)))];
      return {
        ok: false as const,
        code: matches.length > 1 ? "ambiguous_person" : "unknown_person",
        reason:
          matches.length > 1
            ? `More than one person matches "${frameUntrustedText(personGiven, 80)}". Ask which one, and propose again with their email.`
            : `No active member of this company matches "${frameUntrustedText(personGiven, 80)}". Ask the person who they meant.`,
        didYouMean: suggestNames(personGiven, names).map((name) => frameUntrustedText(name, REQUEST_BRIEF_CAPS.person)),
      };
    }
    const target = matches[0]!;
    if (target.userId === owner.userId) {
      return workRefusal(
        "that_is_you",
        "That is you. To hand work to one of your own agents, use inbox_propose; a request goes to someone else.",
      );
    }
    const targetName = frameUntrustedText(target.name, REQUEST_BRIEF_CAPS.person) ?? "that person";

    // The project, when one is named: one the requester sees, and so does the person.
    let project: { id: string; name: string; restricted: boolean } | null = null;
    if (projectGiven) {
      // One query: the company's open projects the requester can see.
      const visible = await db
        .select({ id: projects.id, name: projects.name, visibility: projects.visibility })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, owner.companyId),
            isNull(projects.archivedAt),
            projectVisibilityCondition(owner.req, owner.companyId),
          ),
        );
      const named = visible.filter((row) => normalizeName(row.name) === normalizeName(projectGiven));
      if (named.length !== 1) {
        return {
          ok: false as const,
          code: named.length > 1 ? "ambiguous_project" : "unknown_project",
          reason: `No single project you can see is called "${frameUntrustedText(projectGiven, 80)}". Ask which one, or leave the project out.`,
          didYouMean: suggestNames(projectGiven, visible.map((row) => row.name)).map((name) => frameUntrustedText(name, REQUEST_BRIEF_CAPS.project)),
        };
      }
      const targetReq = personRequest(target.userId, {
        companyId: owner.companyId,
        membershipRole: target.membershipRole,
        status: target.status,
      });
      if (!(await isProjectIdVisible(db, targetReq, named[0]!.id))) {
        return workRefusal(
          "project_hidden_from_person",
          `${targetName} is not on the access list of that project, so they could not see the request. Ask a project lead to add them, or choose another project.`,
        );
      }
      project = {
        id: named[0]!.id,
        name: frameUntrustedText(named[0]!.name, REQUEST_BRIEF_CAPS.project) ?? "the project",
        restricted: named[0]!.visibility === "restricted",
      };
    }

    const routed = await routeFor(owner, target.userId);
    const routedAgentName = routed ? (await agentNames([routed.toAgentId])).get(routed.toAgentId) ?? "their agent" : null;
    const requesterName = (await userNames([owner.userId])).get(owner.userId) ?? null;
    const description = composeRequestDescription({
      requesterName,
      wanted,
      doneMeans,
      forWhom,
      deadline: deadline.date,
    });

    const handle = await mintHandle(owner, "request_work", {
      title,
      description,
      forWhom,
      deadline: deadline.date,
      assigneeUserId: target.userId,
      projectId: project?.id ?? null,
      // What the read-back promised; confirm refuses if it would now differ.
      routedToAgentId: routed?.toAgentId ?? null,
    });

    const goesTo = routed
      ? `${routedAgentName}, ${targetName}'s agent, takes the first pass and asks ${targetName} what it needs.`
      : `${targetName} (no agent takes their work right now, so it stays with them).`;
    const visibility = project?.restricted
      ? `Only people and agents on the access list of the restricted project ${project.name} will see it.`
      : project
        ? `Everyone who can see the project ${project.name} will see it.`
        : "Everyone in the company who can see work outside restricted projects will see it.";

    return {
      ok: true as const,
      handle,
      brief: {
        title,
        wanted,
        doneMeans,
        deadline: deadline.date,
        forWhom,
        person: targetName,
        project: project?.name ?? null,
      },
      goesTo,
      visibility,
      readback: [
        `Ask ${targetName} for: ${title}`,
        `What is wanted: ${wanted}`,
        `What done means: ${doneMeans}`,
        ...(deadline.date ? [`Deadline: ${deadline.date}`] : []),
        ...(forWhom ? [`For: ${forWhom}`] : []),
        ...(project ? [`Project: ${project.name}`] : []),
        `Goes to: ${goesTo}`,
        `Sent as you. ${visibility}`,
      ],
      note: "Nothing is sent yet. Show this read-back and send it with work_request_confirm only after the person's explicit yes to it.",
    };
  }

  // -------------------------------------------------------------------------
  // Close-out: propose accept or changes on a delivered result
  // -------------------------------------------------------------------------

  /** The issue as one of the owner's requests, or a refusal / 404. */
  async function requestIssue(owner: Owner, issueRef: unknown): Promise<IssueRow | WorkRefusal> {
    const { issue } = await work.workIssueAccess(owner, issueRef, { allowRequests: true });
    if (!(await isOwnersRequest(db, owner, issue.id))) {
      return workRefusal(
        "not_your_request",
        "That issue is not one of your requests of someone else. Review it as a hand-off; accepting or asking for changes here is for work you asked another person for.",
      );
    }
    return issue;
  }

  /**
   * The deliverable owner (O7): the agent of the person the request was asked
   * of, by the same routing rule the create used; that person when no agent
   * takes their work. Without a record of who it was asked of, the person
   * holding it keeps it (a person assignment made on the page that the
   * routing rule did not apply to, such as one kept with them on purpose, is
   * not moved to their agent from here), or else the agent holding it, if it
   * is not the requester's own. `hidden` marks an agent the requester cannot
   * see: it is never named to them.
   */
  async function deliverableOwner(owner: Owner, issue: IssueRow) {
    const recorded = (await requestedForUserIds(db, owner.companyId, [issue.id])).get(issue.id) ?? null;
    if (recorded) {
      const routed = await routeFor(owner, recorded);
      if (routed) return { agentId: routed.toAgentId, userId: null, routed, personUserId: recorded, hidden: false };
      const member = await activeMembership(db, owner.companyId, recorded);
      if (member) return { agentId: null, userId: recorded, routed: null, personUserId: recorded, hidden: false };
    } else if (issue.assigneeUserId && issue.assigneeUserId !== owner.userId) {
      const member = await activeMembership(db, owner.companyId, issue.assigneeUserId);
      if (member) {
        return { agentId: null, userId: issue.assigneeUserId, routed: null, personUserId: issue.assigneeUserId, hidden: false };
      }
    }
    if (issue.assigneeAgentId && !owner.agentIds.includes(issue.assigneeAgentId)) {
      const visible = await visibleAgentIdsFor(db, owner.req, owner.companyId);
      const hidden = visible !== null && !visible.has(issue.assigneeAgentId);
      return { agentId: issue.assigneeAgentId, userId: null, routed: null, personUserId: null, hidden };
    }
    return null;
  }

  /** "Agent B, Person B's agent", "Person B", or, for an agent hidden from the requester, never its name. */
  async function deliverableOwnerLabel(target: NonNullable<Awaited<ReturnType<typeof deliverableOwner>>>) {
    if (target.agentId && target.hidden) return HIDDEN_AGENT_LABEL;
    const names = await agentNames([target.agentId]);
    const people = await userNames([target.userId, target.personUserId]);
    if (target.agentId) {
      return `${names.get(target.agentId) ?? "the agent"}${target.personUserId ? `, ${people.get(target.personUserId) ?? "their person"}'s agent` : ""}`;
    }
    return people.get(target.userId!) ?? "that person";
  }

  /** Why a request has no result for the requester yet, in words. */
  async function undeliveredState(issue: IssueRow): Promise<string> {
    if (issue.status === "cancelled") return "cancelled";
    if (issue.status === "in_review" && issue.assigneeAgentId) {
      const steward = (await accountability.resolveForAgents(issue.companyId, [issue.assigneeAgentId])).get(issue.assigneeAgentId);
      const name = steward?.userId ? (await userNames([steward.userId])).get(steward.userId) : null;
      return `in review with ${name ?? "the person whose agent drafted it"}, who finishes it before it comes back to you`;
    }
    return `still being worked on (${issue.status})`;
  }

  async function respond(endpointId: string, input: Record<string, unknown>) {
    const owner = await work.resolveOwner(endpointId);
    if (isWorkRefusal(owner)) return owner;
    const action = str(input.action);
    if (action !== "accept" && action !== "changes") {
      return workRefusal("bad_action", 'action is "accept" or "changes".');
    }
    const issue = await requestIssue(owner, input.issueId);
    if (isWorkRefusal(issue)) return issue;
    const ref = issue.identifier ?? issue.id;
    const title = frameUntrustedText(issue.title, REQUEST_BRIEF_CAPS.title);

    if (!isDeliveredToRequester(issue, owner)) {
      return workRefusal(
        "not_delivered",
        `${ref} has no result to act on yet: it is ${await undeliveredState(issue)}. Check work_list for who has it.`,
      );
    }
    const bound = {
      issueId: issue.id,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
    };

    if (action === "accept") {
      if (str(input.note)) {
        return workRefusal(
          "accept_takes_no_note",
          "Accepting carries no comment: a comment on finished work reopens it. Accept without a note, or ask for changes.",
        );
      }
      const handle = await mintHandle(owner, "request_accept", { ...bound });
      const already = issue.status === "done";
      return {
        ok: true as const,
        handle,
        readback: [
          `Accept ${ref} "${title}" as you.`,
          already
            ? "It is already marked done; this records that you accepted the result."
            : `It moves from ${issue.status} to done.`,
          `Everyone who can see ${ref} will see that you accepted it.`,
        ],
        note: "Nothing is sent yet. Send it with work_request_confirm only after the person's explicit yes to this read-back.",
      };
    }

    const note = str(input.note);
    if (!note) return workRefusal("note_required", "Say what should change: the note is what the agent works from.");
    if (note.length > REQUEST_BRIEF_CAPS.note) {
      return workRefusal("too_long", `The note is over ${REQUEST_BRIEF_CAPS.note.toLocaleString("en-US")} characters. Shorten it.`);
    }
    const target = await deliverableOwner(owner, issue);
    if (!target) {
      return workRefusal(
        "no_deliverable_owner",
        `No one's agent owns ${ref} now, so there is nobody to hand the changes to from here. Reassign it on the page.`,
      );
    }
    const targetLabel = await deliverableOwnerLabel(target);
    const commentBody = `${CHANGE_REQUEST_COMMENT_PREFIX}\n\n${note}`;
    const reassign = (target.agentId ?? null) !== issue.assigneeAgentId || (target.userId ?? null) !== issue.assigneeUserId;
    const handle = await mintHandle(owner, "request_changes", {
      ...bound,
      commentBody,
      targetAgentId: target.agentId,
      targetUserId: target.userId,
      routedFromUserId: target.routed?.fromUserId ?? null,
    });
    return {
      ok: true as const,
      handle,
      comment: commentBody,
      handTo: targetLabel,
      readback: [
        `Ask for changes on ${ref} "${title}", as you:`,
        `Comment: ${commentBody}`,
        `${isClosedIssueStatus(issue.status) ? "Reopen it" : "Move it back"} to todo${reassign ? ` and hand it to ${targetLabel}` : ` with ${targetLabel}`}, who starts on it straight away.`,
        `Everyone who can see ${ref} will see the comment.`,
      ],
      note: "Nothing is sent yet. Send it with work_request_confirm only after the person's explicit yes to this read-back.",
    };
  }

  // -------------------------------------------------------------------------
  // Confirm: spend any request handle
  // -------------------------------------------------------------------------

  async function confirm(endpointId: string, token: string) {
    const owner = await work.resolveOwner(endpointId);
    if (isWorkRefusal(owner)) return owner;
    const record = await consume(token, owner);
    if (!record) {
      return workRefusal(
        "handle_invalid",
        "That confirmation is no longer valid: already used, expired, or not this machine's. Nothing was sent. Propose it again for a fresh read-back.",
      );
    }
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    try {
      if (record.kind === "request_work") return await confirmRequest(owner, payload);
      return await confirmCloseOut(owner, record.kind as "request_accept" | "request_changes", payload);
    } catch (err) {
      if (err instanceof IssueCommentPolicyRefusal) {
        return workRefusal("refused", `${String(err.body.error ?? "Refused")}. Nothing more was sent.`);
      }
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
        return workRefusal("refused", `${err.message}. Nothing more was sent.`);
      }
      throw err;
    }
  }

  async function confirmRequest(owner: Owner, payload: Record<string, unknown>) {
    const assigneeUserId = typeof payload.assigneeUserId === "string" ? payload.assigneeUserId : "";
    const title = typeof payload.title === "string" ? payload.title : "";
    const description = typeof payload.description === "string" ? payload.description : "";
    const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
    if (!assigneeUserId || !title) return workRefusal("handle_invalid", "That confirmation is incomplete. Nothing was sent; propose it again.");

    if (!(await mayAssign(owner))) return workRefusal("not_permitted", NOT_PERMITTED);
    const target = await activeMembership(db, owner.companyId, assigneeUserId);
    if (!target) {
      return workRefusal("person_gone", "That person is no longer an active member of this company. Nothing was sent.");
    }
    if (projectId) {
      const targetReq = personRequest(assigneeUserId, {
        companyId: owner.companyId,
        membershipRole: target.membershipRole,
        status: target.status,
      });
      if (!(await isProjectIdVisible(db, owner.req, projectId)) || !(await isProjectIdVisible(db, targetReq, projectId))) {
        return workRefusal("project_moved_on", "The project's access changed since the read-back. Nothing was sent; propose it again.");
      }
    }
    const routed = await routeFor(owner, assigneeUserId);
    if ((routed?.toAgentId ?? null) !== (payload.routedToAgentId ?? null)) {
      return workRefusal(
        "routing_moved_on",
        "Who would take this changed since the read-back (their agent was paused, started or changed). Nothing was sent; propose it again for a fresh read-back.",
      );
    }

    const channel = channelOf(owner);
    const issue = await issueService(db).create(owner.companyId, {
      title,
      description,
      status: "todo",
      projectId,
      assigneeAgentId: routed?.toAgentId ?? null,
      assigneeUserId: routed ? null : assigneeUserId,
      createdByUserId: owner.userId,
      createdByAgentId: null,
    });
    await issueReferenceService(db)
      .syncIssue(issue.id)
      .catch((err: unknown) => logger.warn({ err, issueId: issue.id }, "bridge request references not synced"));
    await logActivity(db, {
      companyId: owner.companyId,
      actorType: "user",
      actorId: owner.userId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        title: issue.title,
        identifier: issue.identifier,
        ...(routed ? { routedToStewardedAgent: routed } : {}),
        ...channel,
      },
    });
    await logActivity(db, {
      companyId: owner.companyId,
      actorType: "user",
      actorId: owner.userId,
      action: "bridge.work_requested",
      entityType: "issue",
      entityId: issue.id,
      agentId: routed?.toAgentId ?? null,
      details: {
        requestedForUserId: assigneeUserId,
        assigneeAgentId: routed?.toAgentId ?? null,
        deadline: typeof payload.deadline === "string" ? payload.deadline : null,
        ...channel,
      },
    });
    if (options.runtime) {
      await queueIssueAssignmentWakeup({
        heartbeat: options.runtime,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "bridge.work_request",
        requestedByActorType: "user",
        requestedByActorId: owner.userId,
        routedFromStewardUserId: routed?.fromUserId ?? null,
      });
    }
    const names = await agentNames([routed?.toAgentId]);
    const people = await userNames([assigneeUserId]);
    return {
      ok: true as const,
      kind: "request_work" as const,
      issue: { issueId: issue.id, identifier: issue.identifier, title: frameUntrustedText(issue.title, REQUEST_BRIEF_CAPS.title) },
      assignedTo: routed
        ? { kind: "agent" as const, name: names.get(routed.toAgentId) ?? null, forPerson: people.get(assigneeUserId) ?? null }
        : { kind: "person" as const, name: people.get(assigneeUserId) ?? null, forPerson: null },
      note: "Sent as you. It appears under your requests in work_list until you accept the result.",
    };
  }

  async function confirmCloseOut(owner: Owner, kind: "request_accept" | "request_changes", payload: Record<string, unknown>) {
    const issueId = typeof payload.issueId === "string" ? payload.issueId : "";
    const issue = await requestIssue(owner, issueId);
    if (isWorkRefusal(issue)) return issue;
    const ref = issue.identifier ?? issue.id;
    const movedOn =
      issue.status !== payload.status ||
      issue.assigneeAgentId !== (payload.assigneeAgentId ?? null) ||
      issue.assigneeUserId !== (payload.assigneeUserId ?? null);
    if (movedOn || !isDeliveredToRequester(issue, owner)) {
      return workRefusal(
        "moved_on",
        `${ref} changed since the read-back (it is now ${issue.status}). Nothing was sent; read it again and propose again.`,
      );
    }
    if (!options.runtime) throw new HttpError(503, "Issue updates are not available on this server");
    const channel = channelOf(owner);
    // The page's hooks: the review queue follows the status (an accepted
    // in_review result leaves the queue), and completion telemetry.
    const actions = issuePatchActions(db, options.runtime, patchHooks);
    const baseContext = {
      issueId: issue.id,
      companyId: owner.companyId,
      actor: { actorType: "user" as const, actorId: owner.userId, agentId: null, runId: null },
      actorKind: "board",
      actorSource: "bridge_endpoint",
      attribution: channel,
      // The page's PATCH refuses a comment on an issue whose isolated
      // execution workspace is closed; so does a change request from here.
      validate: async (executor: unknown, current: { executionWorkspaceId?: string | null }, intent: { comment?: unknown }) => {
        if (!intent.comment || !current.executionWorkspaceId) return;
        const workspace = await executionWorkspaceService(executor as Db).getById(current.executionWorkspaceId);
        if (workspace && isClosedIsolatedExecutionWorkspace(workspace)) {
          throw new IssueCommentPolicyRefusal(409, { error: getClosedIsolatedExecutionWorkspaceMessage(workspace) });
        }
      },
      validateResume: async () => undefined,
      validateAssignment: async (executor: unknown) => {
        if (!(await mayAssign(owner, executor as Db))) {
          throw new IssueCommentPolicyRefusal(403, { error: "You do not have permission to assign work" });
        }
      },
    };

    if (kind === "request_accept") {
      const fromStatus = issue.status;
      if (issue.status !== "done") {
        const accepted = await actions.accept({ ...baseContext, intent: { status: "done" } } as IssuePatchContext);
        const effects = await actions.dispatch(accepted);
        if (effects.unresolved) logger.warn({ issueId: issue.id, effects: effects.outcomes }, "bridge accept has unresolved effects");
      }
      await logActivity(db, {
        companyId: owner.companyId,
        actorType: "user",
        actorId: owner.userId,
        action: "bridge.work_request_accepted",
        entityType: "issue",
        entityId: issue.id,
        details: { identifier: issue.identifier, fromStatus, ...channel },
      });
      return {
        ok: true as const,
        kind,
        issue: { issueId: issue.id, identifier: issue.identifier, status: "done" },
        note: fromStatus === "done" ? "Recorded that you accepted the result." : `${ref} is done, accepted by you.`,
      };
    }

    // Changes: back to the deliverable owner, re-resolved now and held to the read-back.
    const target = await deliverableOwner(owner, issue);
    if (!target || (target.agentId ?? null) !== (payload.targetAgentId ?? null) || (target.userId ?? null) !== (payload.targetUserId ?? null)) {
      return workRefusal(
        "routing_moved_on",
        `Who would take ${ref} changed since the read-back. Nothing was sent; propose it again for a fresh read-back.`,
      );
    }
    const commentBody = typeof payload.commentBody === "string" ? payload.commentBody : "";
    if (!commentBody) return workRefusal("handle_invalid", "That confirmation is incomplete. Nothing was sent; propose it again.");
    const reassign = (target.agentId ?? null) !== issue.assigneeAgentId || (target.userId ?? null) !== issue.assigneeUserId;
    const routedToStewardedAgent = reassign && target.routed ? target.routed : undefined;
    const accepted = await actions.accept({
      ...baseContext,
      intent: {
        comment: commentBody,
        status: "todo",
        ...(isClosedIssueStatus(issue.status) ? { reopen: true } : {}),
        ...(reassign ? { assigneeAgentId: target.agentId, assigneeUserId: target.userId } : {}),
      },
      requestChanges: true,
      ...(routedToStewardedAgent ? { routedToStewardedAgent } : {}),
    } as IssuePatchContext);
    const effects = await actions.dispatch(accepted);
    if (effects.unresolved) logger.warn({ issueId: issue.id, effects: effects.outcomes }, "bridge change request has unresolved effects");
    const commentId = (accepted.comment as { id?: string } | null)?.id ?? null;
    if (target.agentId) {
      // The correction signal (O6): see recordRequesterChangeRequest.
      await recordRequesterChangeRequest(db, {
        companyId: owner.companyId,
        issueId: issue.id,
        agentId: target.agentId,
        requesterUserId: owner.userId,
        commentId,
        previousStatus: issue.status,
        previousAssigneeAgentId: issue.assigneeAgentId,
        channel,
      }).catch((err) => logger.warn({ err, issueId: issue.id }, "requester change-request correction not recorded"));
    }
    const names = await agentNames([target.agentId]);
    const people = await userNames([target.userId]);
    return {
      ok: true as const,
      kind,
      issue: { issueId: issue.id, identifier: issue.identifier, status: accepted.issue.status },
      commentId,
      handedTo: target.agentId
        ? { kind: "agent" as const, name: target.hidden ? null : names.get(target.agentId) ?? null }
        : { kind: "person" as const, name: people.get(target.userId!) ?? null },
      note: target.agentId ? "Sent as you. The agent is woken with your comment." : "Sent as you. It is back with them, with your comment.",
    };
  }

  // -------------------------------------------------------------------------
  // Your requests: where each one is, and for how long
  // -------------------------------------------------------------------------

  async function describeRequests(owner: Owner, opts: { scan?: number; now?: Date } = {}) {
    const now = opts.now ?? new Date();
    const scan = opts.scan ?? REQUEST_LIMITS.scan;
    const windowStart = new Date(now.getTime() - REQUEST_LIMITS.deliveredWindowDays * 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(issues)
      .where(
        and(
          ownersRequestCondition(owner),
          isNull(issues.hiddenAt),
          ne(issues.status, "cancelled"),
          or(ne(issues.status, "done"), gte(issues.completedAt, windowStart)),
          issueVisibilityCondition(owner.req, owner.companyId),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(scan + 1);
    const scanTruncated = rows.length > scan;
    const candidates = rows.slice(0, scan);
    if (candidates.length === 0) return { items: [] as RequestItem[], scanTruncated };
    const ids = candidates.map((row) => row.id);

    const requestedFor = await requestedForUserIds(db, owner.companyId, ids);
    const questions = new Map(
      (
        await db
          .select({ issueId: issueThreadInteractions.issueId, since: min(issueThreadInteractions.createdAt) })
          .from(issueThreadInteractions)
          .where(
            and(
              inArray(issueThreadInteractions.issueId, ids),
              eq(issueThreadInteractions.kind, "ask_user_questions"),
              eq(issueThreadInteractions.status, "pending"),
            ),
          )
          .groupBy(issueThreadInteractions.issueId)
      ).map((row) => [row.issueId, row.since]),
    );
    const openApprovals = new Map(
      (
        await db
          .select({ issueId: issueApprovals.issueId, since: min(approvals.updatedAt) })
          .from(issueApprovals)
          .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
          .where(and(inArray(issueApprovals.issueId, ids), inArray(approvals.status, [...DECIDABLE_STATUSES])))
          .groupBy(issueApprovals.issueId)
      ).map((row) => [row.issueId, row.since]),
    );
    // When the current holder got it: the last create, status or assignment change.
    const lastChange = new Map(
      (
        await db
          .select({ entityId: activityLog.entityId, at: max(activityLog.createdAt) })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, owner.companyId),
              eq(activityLog.entityType, "issue"),
              inArray(activityLog.entityId, ids),
              inArray(activityLog.action, ["issue.created", "issue.child_created", "issue.updated", "bridge.work_requested"]),
              sql`(${activityLog.action} <> 'issue.updated' or ${activityLog.details} ? 'status' or ${activityLog.details} ? 'assigneeAgentId' or ${activityLog.details} ? 'assigneeUserId')`,
            ),
          )
          .groupBy(activityLog.entityId)
      ).map((row) => [row.entityId, row.at]),
    );
    // The requester acting on a finished result (accepting it, updating or
    // commenting on it) takes it off the delivered list.
    const ownerActed = new Map(
      (
        await db
          .select({ entityId: activityLog.entityId, at: max(activityLog.createdAt) })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, owner.companyId),
              eq(activityLog.entityType, "issue"),
              inArray(activityLog.entityId, ids),
              eq(activityLog.actorType, "user"),
              eq(activityLog.actorId, owner.userId),
              inArray(activityLog.action, [BRIDGE_WORK_REQUEST_ACCEPTED, "issue.updated", "issue.comment_added"]),
            ),
          )
          .groupBy(activityLog.entityId)
      ).map((row) => [row.entityId, row.at]),
    );

    const agentIds = [...new Set(candidates.map((row) => row.assigneeAgentId).filter((id): id is string => Boolean(id)))];
    const accountable = await accountability.resolveForAgents(owner.companyId, agentIds);
    const visibleAgents = await visibleAgentIdsFor(db, owner.req, owner.companyId);
    const agentName = await agentNames(agentIds);
    const people = await userNames([
      ...candidates.map((row) => row.assigneeUserId),
      ...requestedFor.values(),
      ...[...accountable.values()].map((entry) => entry?.userId ?? null),
    ]);

    const items: RequestItem[] = [];
    for (const row of candidates) {
      const requestedOfId = requestedFor.get(row.id) ?? (row.assigneeUserId !== owner.userId ? row.assigneeUserId : null);
      const changedAt = lastChange.get(row.id) ?? row.createdAt;
      let delivered = false;
      let waitingOn: RequestItem["waitingOn"];
      let since: Date;
      let summaryTail: string;

      if (row.status === "done") {
        const doneAt = row.completedAt ?? changedAt;
        const acted = ownerActed.get(row.id);
        if (acted && acted.getTime() >= doneAt.getTime() - ACK_CLOCK_SKEW_MS) continue;
        delivered = true;
        waitingOn = { kind: "you", name: null, why: "result_done" };
        since = doneAt;
        summaryTail = "";
      } else if (row.assigneeUserId === owner.userId) {
        delivered = true;
        waitingOn = { kind: "you", name: null, why: "handed_back" };
        since = changedAt;
        summaryTail = "";
      } else if (row.status === "in_review" && isDeliveredToRequester(row, owner)) {
        delivered = true;
        waitingOn = { kind: "you", name: null, why: "ready_for_review" };
        since = changedAt;
        summaryTail = "";
      } else if (row.assigneeAgentId) {
        const seen = visibleAgents === null || visibleAgents.has(row.assigneeAgentId);
        const name = seen ? agentName.get(row.assigneeAgentId) ?? "an agent" : null;
        const personId = accountable.get(row.assigneeAgentId)?.userId ?? null;
        const personName = personId ? people.get(personId) ?? null : null;
        const question = questions.get(row.id);
        const approval = openApprovals.get(row.id);
        if (question && personName) {
          waitingOn = { kind: "person", name: personName, why: "agent_question" };
          since = question;
          summaryTail = ` (${name ?? "their agent"} asked them a question)`;
        } else if (approval && personName) {
          waitingOn = { kind: "person", name: personName, why: "approval" };
          since = approval;
          summaryTail = ` (an approval for ${name ?? "their agent"})`;
        } else if (row.status === "in_review" && personName) {
          // The agent handed its draft to its own person, who finishes it
          // before the result comes back to the requester.
          waitingOn = { kind: "person", name: personName, why: "steward_review" };
          since = changedAt;
          summaryTail = ` (${name ?? "their agent"}'s draft is in their review)`;
        } else {
          waitingOn = { kind: "agent", name, why: row.status === "blocked" ? "blocked" : "working" };
          since = changedAt;
          summaryTail = row.status === "blocked" ? " (blocked)" : row.status === "in_progress" ? " (working on it)" : ` (${row.status})`;
        }
      } else if (row.assigneeUserId) {
        waitingOn = { kind: "person", name: people.get(row.assigneeUserId) ?? "a person", why: "assigned" };
        since = changedAt;
        summaryTail = row.status === "blocked" ? " (blocked)" : row.status === "in_review" ? " (in review)" : "";
      } else {
        waitingOn = { kind: "nobody", name: null, why: "unassigned" };
        since = changedAt;
        summaryTail = "";
      }

      const waitedMs = Math.max(0, now.getTime() - since.getTime());
      const words = waitedInWords(waitedMs);
      let summary: string;
      if (waitingOn.why === "result_done") summary = `done ${words} ago; accept it or ask for changes`;
      else if (waitingOn.why === "handed_back") summary = `handed back to you ${words} ago; accept it or ask for changes`;
      else if (waitingOn.why === "ready_for_review") summary = `ready for your review for ${words}; accept it or ask for changes`;
      else if (waitingOn.kind === "nobody") summary = `unassigned for ${words}`;
      else summary = `waiting on ${waitingOn.name ?? "an agent you cannot see"} for ${words}${summaryTail}`;

      items.push({
        issueId: row.id,
        identifier: row.identifier,
        title: frameUntrustedText(row.title, REQUEST_BRIEF_CAPS.title),
        status: row.status,
        requestedOf: requestedOfId ? people.get(requestedOfId) ?? null : null,
        delivered,
        waitingOn,
        waitingSince: since.toISOString(),
        waitedSeconds: Math.floor(waitedMs / 1000),
        summary,
        doneAt: row.status === "done" ? (row.completedAt ?? changedAt).toISOString() : null,
      });
    }
    // Longest wait first in each list.
    items.sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince));
    return { items, scanTruncated };
  }

  function section(items: RequestItem[], limit: number) {
    const shown = items.slice(0, limit);
    return { total: items.length, shown: shown.length, truncated: items.length > shown.length, items: shown };
  }

  /** `work_list`'s "your requests": delivered results first, then what is still waiting. */
  async function listForOwner(owner: Owner, input: { limit?: unknown } = {}) {
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.min(Math.max(Math.floor(input.limit), 1), REQUEST_LIMITS.listMax)
        : REQUEST_LIMITS.listDefault;
    const { items, scanTruncated } = await describeRequests(owner);
    const delivered = items.filter((item) => item.delivered);
    const waiting = items.filter((item) => !item.delivered);
    return {
      total: items.length,
      delivered: section(delivered, limit),
      waiting: section(waiting, limit),
      scanTruncated,
      note:
        `Work you asked other people for. A delivered result stays here until you accept it, ask for changes, or act on it on the page (at most ${REQUEST_LIMITS.deliveredWindowDays} days after it was done). ` +
        "Accept or ask for changes with work_request_respond; read one with work_read.",
    };
  }

  /**
   * The SessionStart digest's "Your requests": counts and a few pointers,
   * never the content. Null when this endpoint or company does not have the
   * co-worker surface, so the section is simply absent.
   */
  async function digestSection(endpointId: string) {
    let owner: Owner | WorkRefusal;
    try {
      owner = await work.resolveOwner(endpointId);
    } catch (err) {
      if (err instanceof HttpError) return null;
      throw err;
    }
    if (isWorkRefusal(owner)) return null;
    // Bounded: the digest runs on every session start. Past the cap the
    // counts are a floor, said by `truncated`, and work_list has the rest.
    const { items, scanTruncated } = await describeRequests(owner, { scan: REQUEST_LIMITS.digestScan });
    const delivered = items.filter((item) => item.delivered);
    const waiting = items.filter((item) => !item.delivered);
    const pointers = [...delivered, ...waiting].slice(0, REQUEST_LIMITS.digestItems).map((item) => ({
      issueId: item.issueId,
      identifier: item.identifier,
      title: item.title,
      delivered: item.delivered,
      summary: item.summary,
    }));
    return {
      total: items.length,
      delivered: delivered.length,
      waiting: waiting.length,
      shown: pointers.length,
      truncated: scanTruncated,
      items: pointers,
    };
  }

  async function list(endpointId: string, input: { limit?: unknown } = {}) {
    const owner = await work.resolveOwner(endpointId);
    if (isWorkRefusal(owner)) return owner;
    return listForOwner(owner, input);
  }

  return { propose, respond, confirm, list, listForOwner, digestSection };
}
