import type { ActivityEvent } from "@paperclipai/shared";

/**
 * Turn one activity row into a sentence a steward can read.
 *
 * The page used to render `action.replace(/[._]/g, " ")`, which produced
 * "issue updated": an enum with the punctuation taken out, no actor, and no
 * time. The server logs 275 distinct action strings, so a lookup table would
 * cover a fraction of them and leave the rest looking broken beside the ones it
 * did cover — worse than translating none.
 *
 * 83% of those strings are `<entity>.<verb>` instead, and the verbs have a
 * small head: created, updated, deleted, approved, rejected, revoked. So this
 * composes from the two halves independently and falls back to the previous
 * wording — never to a blank — whenever it does not recognise a half. An
 * unrecognised action still gains an actor and a timestamp, which is most of
 * what was missing.
 *
 * Nouns deliberately match the product's own vocabulary ("an issue", not "a
 * task"). Inventing friendlier words here would disagree with the sidebar the
 * reader is looking at, which costs more comprehension than the jargon does.
 */

/** The verb tail, mapped to a phrase that completes "<actor> …". */
const VERBS: Record<string, string> = {
  created: "created",
  updated: "updated",
  deleted: "deleted",
  archived: "archived",
  restored: "restored",
  approved: "approved",
  rejected: "rejected",
  revoked: "revoked",
  cancelled: "cancelled",
  reported: "reported",
  completed: "finished",
  finished: "finished",
  started: "started",
  assigned: "was given",
  work_assigned: "was given",
  comment_added: "commented on",
  budget_updated: "changed the budget on",
  permissions_updated: "changed permissions on",
};

/** The entity head, as a noun phrase. */
const ENTITIES: Record<string, string> = {
  issue: "an issue",
  approval: "an approval",
  project: "a project",
  goal: "a goal",
  routine: "a routine",
  deliverable: "a deliverable",
  document: "a document",
  agent: "the agent",
  agent_fact: "a fact request",
  company: "the workspace",
  company_member: "a member",
  heartbeat: "a scheduled run",
  environment: "the environment",
  connection: "a connection",
  secret: "a secret",
  bridge: "the machine connection",
  evaluation: "an evaluation",
  invite: "an invitation",
  human_channel: "a message channel",
};

/**
 * Who did it.
 *
 * `actorType: "user"` is not necessarily the reader — an administrator can act
 * on someone else's agent — so this only says "You" when the actor id matches
 * the viewer's own. Saying "You" for a teammate's action would be a lie in the
 * one place a steward is looking to spot something they did not do.
 */
export function describeActor(
  event: Pick<ActivityEvent, "actorType" | "actorId">,
  agentName: string,
  viewerUserId: string | null,
): string {
  switch (event.actorType) {
    case "agent":
      return agentName;
    case "user":
      return viewerUserId && event.actorId === viewerUserId ? "You" : "A teammate";
    case "system":
      return "AgentDash";
    case "plugin":
      return "An integration";
    default:
      return "Someone";
  }
}

/** A quoted title from `details`, when there is one worth showing. */
function titleFrom(details: ActivityEvent["details"]): string | null {
  if (!details) return null;
  for (const key of ["title", "name", "identifier"]) {
    const value = details[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function describeActivity(
  event: Pick<ActivityEvent, "action" | "actorType" | "actorId" | "details">,
  agentName: string,
  viewerUserId: string | null = null,
): string {
  const actor = describeActor(event, agentName, viewerUserId);
  const title = titleFrom(event.details);

  const dot = event.action.indexOf(".");
  if (dot > 0) {
    const entity = ENTITIES[event.action.slice(0, dot)];
    const verb = VERBS[event.action.slice(dot + 1)];
    if (entity && verb) {
      const base = `${actor} ${verb} ${entity}`;
      return title ? `${base} — ${title}` : base;
    }
  }

  // Unrecognised. Keep the old wording rather than guess, but the actor and
  // (at the call site) the timestamp are still an improvement on the enum.
  const readable = event.action.replace(/[._]/g, " ");
  return title ? `${actor}: ${readable} — ${title}` : `${actor}: ${readable}`;
}
