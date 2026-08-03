import type { PaperclipApiClient } from "./client.js";

/**
 * AgentDash-MK Slice G9: the derivation record, served over MCP.
 *
 * ## What this is, and what it is not
 *
 * **Shared context. Not governance.** MCP resources are application-controlled
 * and MCP prompts are user-controlled; either way, nothing verifies that a
 * harness read anything and nothing here could. Any harness in the firm can ask
 * where a number comes from and get the answer that was actually used — and
 * that is the whole claim. Describing it as a policy anyone must follow would
 * be asserting a control that does not exist, which is worse than shipping no
 * control at all, because the second is visibly absent and the first is
 * invisibly false.
 *
 * ## Why every figure carries its age
 *
 * A human at the end of a workflow catches errors but not wrong foundations. A
 * stale premise passes review silently, every time, because it looks exactly
 * like a fresh one. So the age and the last confirmation travel *with* the
 * number rather than being available next to it: a reader who does not think to
 * ask "how old is this" is told anyway.
 *
 * ## Read-only, structurally
 *
 * One HTTP verb appears in this file and it is `GET`. There is no write path to
 * forget to remove, and a test asserts that both resources issue nothing else.
 */

export interface ResourceContext {
  companyId: string | null;
}

/**
 * The `resources/read` result shape.
 *
 * The index signature is what the MCP SDK's `ServerResult` union requires of a
 * handler return; without it TypeScript reads this as a closed object that
 * cannot be one of the union's members. It is structural, not decorative.
 */
export interface ResourceContents {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
  [key: string]: unknown;
}

/** The static resources this server has always served. */
export function listResources() {
  return [
    {
      uri: "agentdash://playbook",
      name: "Operating Playbook",
      description:
        "The goal-oriented operating contract: the setup-status loop, the approval boundaries, "
        + "and what to do when blocked. Read this before operating.",
      mimeType: "text/markdown",
    },
    {
      uri: "agentdash://dashboard",
      name: "Dashboard URL",
      description: "The AgentDash dashboard URL for this workspace",
      mimeType: "text/plain",
    },
    {
      uri: "agentdash://agents",
      name: "Agent Roster",
      description: "Current list of agents and their statuses",
      mimeType: "application/json",
    },
    {
      uri: "agentdash://tasks",
      name: "Task Board",
      description: "Current tasks and their statuses",
      mimeType: "application/json",
    },
  ];
}

/**
 * The derivation record's two templates.
 *
 * Both descriptions state the limit plainly, and a test asserts they do. It is
 * the one place a reader forms an expectation about what this endpoint means,
 * and "context you may read" and "rules you must follow" are very different
 * promises to make to somebody's harness.
 */
export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "agentdash://facts/{key}",
    name: "Fact derivation record",
    description:
      "Where one figure comes from: its current value, the exact call that produced it, its "
      + "derivation in words, every correction recorded against it, how old it is, and who last "
      + "confirmed it. Read-only shared context — nothing verifies that this was read and nothing "
      + "here is enforced. `{key}` is the fact key; prefix it with `deliverable/` when the same "
      + "fact key exists on more than one deliverable.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "agentdash://deliverables/{key}/latest",
    name: "Last shipped deliverable",
    description:
      "The most recent approved and shipped cycle of a deliverable, with provenance and age on "
      + "every figure and both approvals named. Read-only shared context — nothing verifies that "
      + "this was read, and it is not policy.",
    mimeType: "application/json",
  },
] as const;

/**
 * Parse `agentdash://facts/{key}`.
 *
 * The key is decoded and re-encoded rather than pasted through. A key
 * containing `/` or `..` would otherwise become path *structure* in the
 * control-plane URL instead of staying a path segment, which is a traversal in
 * a place nobody looks for one.
 */
function factRecordPath(companyId: string, rest: string): string {
  const key = decodeURIComponent(rest);
  return `/companies/${encodeURIComponent(companyId)}/fact-records/${encodeURIComponent(key)}`;
}

function latestRunPath(companyId: string, rest: string): string {
  const key = decodeURIComponent(rest.slice(0, -"/latest".length));
  return `/companies/${encodeURIComponent(companyId)}/deliverables/${encodeURIComponent(key)}/latest`;
}

function hint(uri: string, message: string): ResourceContents {
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ hint: message }) }],
  };
}

/**
 * Serve one derivation resource, or null if this file does not own the URI.
 *
 * Null rather than throwing, so the server's read handler can try these first
 * and fall through to the static resources without either side knowing about
 * the other's URIs.
 */
export async function readAgentDashResource(
  client: PaperclipApiClient,
  context: ResourceContext,
  uri: string,
): Promise<ResourceContents | null> {
  const factPrefix = "agentdash://facts/";
  const deliverablePrefix = "agentdash://deliverables/";

  let path: string | null = null;
  if (uri.startsWith(factPrefix)) {
    if (!context.companyId) {
      return hint(uri, "Set PAPERCLIP_COMPANY_ID (or AGENTDASH_COMPANY_ID) to read fact records");
    }
    path = factRecordPath(context.companyId, uri.slice(factPrefix.length));
  } else if (uri.startsWith(deliverablePrefix) && uri.endsWith("/latest")) {
    if (!context.companyId) {
      return hint(
        uri,
        "Set PAPERCLIP_COMPANY_ID (or AGENTDASH_COMPANY_ID) to read a deliverable's last shipped run",
      );
    }
    path = latestRunPath(context.companyId, uri.slice(deliverablePrefix.length));
  }
  if (!path) return null;

  // GET, always. This surface exists to report what a number is, never to
  // change one — and read-only here is the absence of any other verb rather
  // than a rule somebody follows.
  const body = await client.requestJson("GET", path);
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) }],
  };
}
