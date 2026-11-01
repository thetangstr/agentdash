import { z } from "zod";
import { formatTextResponse } from "./format.js";
import type { ToolDefinition } from "./tools.js";

// ---------------------------------------------------------------------------
// AgentDash cloud toolset (doc/plans/2026-10-31-cloud-mcp-toolset.md).
//
// Four tools that let any agent get a person an AgentDash cloud workspace and
// then onto it, through the normal self-serve journey:
//
//   check_name → start (the PERSON gets the verification email) → status
//   (email_pending … active) → connect (the PERSON approves on the box) →
//   the session continues with the setup toolset.
//
// The tools are transport-agnostic. They validate input and hand it to a
// CloudBackend, which is either
//
//   - httpCloudBackend: stdio, calling the public cloud API
//     (`POST https://www.agentdash.cloud/api/cloud/agent/<op>`), or
//   - an in-process backend inside cloud-control itself, for the hosted
//     streamable-HTTP endpoint (`POST /api/cloud/mcp`, cloud/src/routes/agent.ts).
//
// Both run these same definitions, so the two transports cannot drift. The
// control plane writes every user-facing answer (state, plain next steps);
// this layer adds only what is transport-specific: over stdio, a successful
// connect upgrades the running session in place (like agentdash_sign_up).
// ---------------------------------------------------------------------------

export const DEFAULT_CLOUD_URL = "https://www.agentdash.cloud";
/** Workspaces live at https://<slug>.<edge domain>. */
export const DEFAULT_EDGE_DOMAIN = "agentdash.cloud";

/**
 * The edge domain a cloud's workspaces live under: an explicit override, else
 * the cloud's host without `www.` (www.agentdash.cloud → agentdash.cloud), else
 * the default.
 */
export function edgeDomainFor(cloudUrl: string, override?: string | null): string {
  const explicit = override?.trim().toLowerCase();
  if (explicit) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(explicit)) throw new Error("AGENTDASH_CLOUD_EDGE_DOMAIN must be a domain name");
    return explicit;
  }
  const host = new URL(normalizeCloudUrl(cloudUrl)).hostname;
  return host.startsWith("www.") ? host.slice(4) : DEFAULT_EDGE_DOMAIN;
}

/** The operations the cloud agent API answers, as `POST /api/cloud/agent/<op>`. */
export const CLOUD_OPS = ["check-name", "start", "status", "connect"] as const;
export type CloudOp = (typeof CLOUD_OPS)[number];

export interface CloudCallResult {
  /** HTTP status of the answer; 0 when the cloud could not be reached. */
  status: number;
  body: Record<string, unknown>;
}

export interface CloudBackend {
  call(op: CloudOp, input: Record<string, unknown>): Promise<CloudCallResult>;
}

/** What a successful connect hands the transport, once. */
export interface CloudConnection {
  boxUrl: string;
  apiUrl: string;
  apiKey: string;
}

/**
 * The cloud origin from an operator-supplied URL: `https://www.agentdash.cloud`,
 * with or without a trailing slash, `/api` or `/api/cloud`. Plain http is
 * allowed only for a loopback host (local development and tests): the handle
 * and, at connect, a board key travel over this connection.
 */
export function normalizeCloudUrl(raw: string | undefined | null): string {
  const value = (raw ?? "").trim() || DEFAULT_CLOUD_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`AGENTDASH_CLOUD_URL is not a URL: ${value}`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("AGENTDASH_CLOUD_URL must be https (http only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("AGENTDASH_CLOUD_URL must not carry credentials, a query or a fragment");
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api(\/cloud)?$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { error: "unexpected answer from the AgentDash cloud" };
  } catch {
    return { error: "unexpected answer from the AgentDash cloud" };
  }
}

/** stdio: the public cloud API. Handles travel only in POST bodies, never in a URL. */
export function httpCloudBackend(cloudUrl: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): CloudBackend {
  const base = normalizeCloudUrl(cloudUrl);
  return {
    async call(op, input) {
      const f = opts.fetch ?? fetch;
      let response: Response;
      try {
        response = await f(`${base}/api/cloud/agent/${op}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
          // A redirect would re-send the handle to wherever it points.
          redirect: "error",
        });
      } catch {
        return {
          status: 0,
          body: {
            error: `Could not reach the AgentDash cloud at ${base}. Check the network (or AGENTDASH_CLOUD_URL) and try again.`,
            code: "cloud_unreachable",
          },
        };
      }
      return { status: response.status, body: await readJson(response) };
    },
  };
}

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

function answer(result: CloudCallResult, extra: Record<string, unknown> = {}): ToolResult {
  const body = { ...result.body, ...extra };
  if (result.status >= 200 && result.status < 300) return formatTextResponse(body);
  return { ...formatTextResponse({ ...body, status: result.status }), isError: true };
}

function tool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  run: (input: z.infer<typeof schema>) => Promise<ToolResult>,
  annotations?: Record<string, unknown>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    ...(annotations ? { annotations } : {}),
    execute: async (input) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return {
          ...formatTextResponse({ error: "invalid input", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`) }),
          isError: true,
        };
      }
      return await run(parsed.data);
    },
  };
}

const HANDLE = z
  .string()
  .trim()
  .regex(/^agdh_[A-Za-z0-9_-]{43}$/, "not an AgentDash cloud handle (agdh_…)")
  .describe("The handle agentdash_cloud_start returned. Keep it private, like a password; it expires after 7 days.");

const SLUG = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .describe("The workspace name: becomes https://<slug>.agentdash.cloud. 3 to 16 lowercase letters, digits or dashes, starting with a letter.");

/** `boxUrl` is a bare https origin `https://<slug>.<edgeDomain>`, and `apiUrl` is exactly its `/api`. */
export function isWorkspaceApi(boxUrl: string, apiUrl: string, edgeDomain: string = DEFAULT_EDGE_DOMAIN): boolean {
  try {
    const box = new URL(boxUrl);
    const label = box.hostname.endsWith(`.${edgeDomain}`) ? box.hostname.slice(0, -(edgeDomain.length + 1)) : "";
    return box.protocol === "https:" && !box.port && /^[a-z0-9-]+$/.test(label)
      && box.origin === boxUrl.replace(/\/+$/, "") && apiUrl === `${box.origin}/api`;
  } catch {
    return false;
  }
}

export interface CloudToolOptions {
  /**
   * Called once when connect delivers the box credential. stdio upgrades the
   * running session here and returns what to add to the answer; the hosted
   * endpoint passes nothing (it cannot hold a session).
   */
  onConnected?: (connection: CloudConnection) => Promise<Record<string, unknown>>;
  /** Where workspaces may live; a connect answer naming any other host is not followed. */
  edgeDomain?: string;
}

export function createCloudToolDefinitions(backend: CloudBackend, options: CloudToolOptions = {}): ToolDefinition[] {
  return [
    tool(
      "agentdash_cloud_check_name",
      "Check whether a workspace name (slug) is free for a new AgentDash cloud workspace at "
        + "https://<slug>.agentdash.cloud. Read-only. Answers {available} or {available: false, reason, message}.",
      z.object({ slug: SLUG }),
      async ({ slug }) => answer(await backend.call("check-name", { slug })),
      { readOnlyHint: true },
    ),
    tool(
      "agentdash_cloud_start",
      "Start the normal self-serve signup for a new AgentDash cloud workspace on the PERSON's behalf. "
        + "Collect their email in conversation (NEVER invent one) and a workspace name, and ask them to read and "
        + "accept the terms (https://www.agentdash.cloud/terms) before you call this. The PERSON receives the "
        + "verification email and must click it themselves; you never see that link. Returns an opaque handle "
        + "(once — store it privately; it expires after 7 days) and plain next steps. Without a valid admission "
        + "code the workspace waits for approval after verification (the waitlist); with one, it is approved once "
        + "the email is verified. Then poll agentdash_cloud_status.",
      z.object({
        email: z.string().trim().email().max(254).describe("The person's own email address. They receive the verification link there."),
        slug: SLUG,
        workspaceName: z.string().trim().min(2).max(80).optional().describe("Display name; defaults to the slug."),
        admissionCode: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .optional()
          .describe("An AgentDash hosted admission code (AGD-HOST-…) the person was given. Ask for it; NEVER invent or guess one."),
        acceptTerms: z
          .literal(true)
          .describe("true only after the person has read and accepted the terms at https://www.agentdash.cloud/terms."),
      }),
      async (input) => answer(await backend.call("start", input as Record<string, unknown>)),
    ),
    tool(
      "agentdash_cloud_status",
      "Where the signup behind a handle stands. Read-only. state is one of: email_pending (the person has not "
        + "clicked the verification email yet), waitlisted (verified, waiting for approval or capacity), "
        + "provisioning (with step), awaiting_claim (ready: the person opens the claim link in THEIR email and "
        + "sets a password — you never get that link), active (claimed: call agentdash_cloud_connect), or failed "
        + "(with reason). Each answer carries nextSteps in plain words. Poll every 15 to 30 seconds while "
        + "provisioning; less often while waiting on the person.",
      z.object({ handle: HANDLE }),
      async ({ handle }) => answer(await backend.call("status", { handle })),
      { readOnlyHint: true },
    ),
    tool(
      "agentdash_cloud_connect",
      "Once the workspace is claimed (status active), ask the person to let you onto it. The first call returns "
        + "an approvalUrl on their workspace and a confirmationCode: give both to the person, who signs in there, checks "
        + "the page shows the same code, and clicks Approve. Call "
        + "again after they approve: the workspace credential is delivered to you exactly once. Over stdio this "
        + "session then switches to the workspace in place — continue with agentdash_setup_status (interview → "
        + "plan → hire), no reconfiguring; over the hosted endpoint, store the credential as a secret. "
        + "restart: true replaces a pending request whose link was lost or expired, or one the person declined.",
      z.object({
        handle: HANDLE,
        restart: z.boolean().optional().describe("Cancel a pending approval request and make a new one."),
      }),
      async ({ handle, restart }) => {
        const result = await backend.call("connect", { handle, ...(restart ? { restart: true } : {}) });
        const body = result.body;
        if (
          options.onConnected
          && result.status === 200
          && body.state === "connected"
          && typeof body.apiKey === "string"
          && typeof body.apiUrl === "string"
          && typeof body.boxUrl === "string"
        ) {
          // The session re-points itself only at an https workspace whose API
          // is the box URL's own /api: never at whatever URL an answer names.
          if (!isWorkspaceApi(body.boxUrl, body.apiUrl, options.edgeDomain)) {
            return answer(result, { sessionUpgraded: false, upgradeRefused: "the workspace URL in the answer is not an https AgentDash workspace" });
          }
          const extra = await options.onConnected({ boxUrl: body.boxUrl, apiUrl: body.apiUrl, apiKey: body.apiKey });
          return answer(result, extra);
        }
        return answer(result);
      },
    ),
  ];
}

/** The `instructions` a cloud-toolset session gets (src/playbook.ts re-exports it). */
export const CLOUD_PLAYBOOK = `# AgentDash Cloud Playbook

You are helping a person get their own AgentDash cloud workspace (https://<name>.agentdash.cloud) and then set up their company on it. The person stays in charge of their identity and their workspace: they verify their email, they set their own password, and they approve your access. You never see their verification link, their claim link, their password or a browser session, and you must never ask for them.

## The journey
1. Ask the person for their email (NEVER invent one) and a workspace name. Check the name with agentdash_cloud_check_name.
2. Show them the terms (https://www.agentdash.cloud/terms) and ask whether they accept. Ask whether they have an AgentDash admission code (AGD-HOST-…); NEVER invent or guess one.
3. Call agentdash_cloud_start. Store the handle privately: it is the only way back to this signup and it is shown once. Tell the person to open the verification email AgentDash just sent them.
4. Poll agentdash_cloud_status and relay its nextSteps in plain words:
   - email_pending: they have not clicked the email yet. Links expire after 30 minutes; if it expired, start again.
   - waitlisted: verified, waiting for approval (no admission code) or for capacity. Nothing to do but wait; poll rarely.
   - provisioning: about 2 to 3 minutes. Poll every 15 to 30 seconds.
   - awaiting_claim: ready. The person opens the claim link in THEIR email (also on their progress page), sets their password, and lands in the workspace.
   - active: claimed. Go to step 5.
   - failed: say what the reason means; do not retry blindly.
5. Call agentdash_cloud_connect. Give the person the approvalUrl and the confirmationCode: they sign in on their workspace, check that the page shows the same code, and click Approve (if the codes differ, they must not approve). Then call agentdash_cloud_connect again.
6. Once connected over stdio this session talks to the workspace: call agentdash_setup_status and follow its nextAction (model adapter → interview → plan → hire), exactly as the setup toolset describes. Tell the person to persist the workspace key so future sessions stay signed in.

## Boundaries
- One workspace per person. Never sign anyone up without their explicit request, and never with an email that is not theirs.
- Never brute-force names, codes or handles. Respect rate limits: a 429 means wait.
- Hiring beyond the confirmed plan, deleting anything and changing budgets still need agentdash_request_approval on the workspace, as in the setup playbook.
`;
