import { logger } from "../middleware/logger.js";
import { deriveCompanyEmailDomain } from "@paperclipai/shared";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";
import { SingleCompanyInstallationError } from "./companies.js";
import { pairFounderWithAgent, type FounderStewardshipDeps } from "./founder-stewardship.js";
import { normalizeHumanRole } from "./company-member-roles.js";
import { HttpError, badRequest, conflict, forbidden } from "../errors.js";
import { isHostedBox } from "./license.js";
import {
  exceededFreeTierCapacityAction,
  freeTierCapExceededPayload,
  type TierCapAction,
  type TierCapacityAdds,
  type TierCapacityDeps,
} from "./tier-policy.js";

// AgentDash (#102): true when the single-company-installation constraint should
// be bypassed. Mirrors the same check in server/src/routes/companies.ts.
function isSingleCompanyOverrideActive() {
  // AgentDash (#725): a hosted box holds exactly one company; no override.
  if (isHostedBox()) return false;
  if (process.env.AGENTDASH_ALLOW_MULTI_COMPANY === "true") return true;
  if (process.env.AGENTDASH_DEV_MODE === "true") return true;
  return false;
}

// Phase 0 of the CoS-led onboarding flow (see
// docs/superpowers/specs/2026-05-04-cos-onboarding-conversation-design.md).
// One rich opening message — greeting + role + first goal question, in that
// order — posted atomically inside bootstrap() the FIRST time a conversation
// is created for a workspace. The atomicity is crucial: concurrent bootstrap
// calls (auth-hook + UI `useEffect` under React StrictMode) all converge on
// the existing conversation and skip the welcome.
//
// Why ONE message instead of four: the user's feedback was the previous
// 4-bubble sequence read like a robot survey, not a conversation. A real
// Chief of Staff introduces themselves and asks one substantive question.
// Subsequent turns are LLM-driven (Phase 1+).

export function buildPhase0Greeting(
  userName: string | null | undefined,
  companyName: string | null | undefined,
): string {
  const firstName = (userName ?? "").trim().split(/\s+/)[0] || null;
  const salutation = firstName ? `Hi ${firstName}!` : "Hi there!";
  // The Chief of Staff belongs to THIS company, not to the product it runs on.
  // Introducing itself as "your Chief of Staff at AgentDash" told the founder of
  // MKThink they had hired somebody else's employee — reported as #449, where
  // the greeting naming the vendor was the part that survived every later
  // rewrite of this flow. Falls back to the product name only when the company
  // has none, which is a workspace that has not been named yet.
  const employer = (companyName ?? "").trim() || "AgentDash";
  return [
    `${salutation} I'm your Chief of Staff at ${employer}.`,
    `You're about to build out an AI workforce — agents that take on roles you'd normally hire employees for. My job is to figure out what kind of team you need and get them set up.`,
    `To start, tell me what you're trying to accomplish. What's your top short-term goal, and where do you want this to be in 6–12 months?`,
  ].join("\n\n");
}

async function postWelcomeSequence(
  conversations: any,
  conversationId: string,
  cosAgentId: string,
  userName: string | null | undefined,
  companyName: string | null | undefined,
): Promise<void> {
  await conversations.postMessage({
    conversationId,
    authorKind: "agent",
    authorId: cosAgentId,
    body: buildPhase0Greeting(userName, companyName),
  });
}

interface BootstrapServices {
  access: any;          // accessService(db)
  companies: any;       // companyService(db)
  agents: any;          // agentService(db)
  instructions: any;    // agentInstructionsService()
  conversations: any;   // conversationService(db)
  users: any;           // user lookup (auth-users service or direct query)
}

interface Deps extends BootstrapServices {
  /** AgentDash (scan 2, E3): pairs the owner with the CoS; omitted in older wiring and tests. */
  stewardships?: FounderStewardshipDeps;
  tierCapacity?: {
    withCompanyLock<T>(
      companyId: string,
      work: (services: BootstrapServices) => Promise<T>,
    ): Promise<T>;
    capacityDepsFor(services: BootstrapServices): TierCapacityDeps;
  };
}

interface BootstrapResult {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
}

export class OnboardingTierCapacityExceededError extends Error {
  readonly action: TierCapAction;
  readonly code: string;

  constructor(action: TierCapAction) {
    const payload = freeTierCapExceededPayload(action);
    super(payload.message);
    this.action = action;
    this.code = payload.code;
  }
}

// AgentDash (security, GH #977): a bootstrap with no companyId used to reuse
// the FIRST active membership — arbitrary for a user who belongs to several
// workspaces, so a CoS could be provisioned in a company the caller did not
// intend. With more than one active membership the request is refused and the
// caller chooses explicitly; a single active membership is still inferred.
export class AmbiguousWorkspaceBootstrapError extends Error {
  readonly code = "ambiguous_company";
  readonly companies: Array<{ id: string; name: string | null }>;

  constructor(companies: Array<{ id: string; name: string | null }>) {
    super(
      "You belong to more than one workspace. Pass companyId to choose which workspace to bootstrap.",
    );
    this.name = "AmbiguousWorkspaceBootstrapError";
    this.companies = companies;
  }
}

// In `local_trusted` deployment mode, the synthetic actor has userId="local-board"
// and there is NO auth_users row. The orchestrator must still bootstrap a working
// workspace so the founding user can hit /cos and start chatting.
const LOCAL_BOARD_USER_ID = "local-board";

function resolveLocalUser(userId: string): { id: string; email: string | null } | null {
  if (userId !== LOCAL_BOARD_USER_ID) return null;
  // Optional override: AGENTDASH_BOOTSTRAP_EMAIL lets the founding user supply a
  // real email so the company name + email_domain are set correctly. Falls back
  // to a generic "Local Workspace" when unset.
  const email = process.env.AGENTDASH_BOOTSTRAP_EMAIL?.trim() || null;
  return { id: LOCAL_BOARD_USER_ID, email };
}

export function onboardingOrchestrator(deps: Deps) {
  async function assertBootstrapTierCapacity(
    services: BootstrapServices,
    companyId: string,
    adds: TierCapacityAdds,
  ) {
    if (!deps.tierCapacity) return;
    const blockedAction = await exceededFreeTierCapacityAction(
      deps.tierCapacity.capacityDepsFor(services),
      companyId,
      adds,
    );
    if (blockedAction) throw new OnboardingTierCapacityExceededError(blockedAction);
  }

  async function finalizeBootstrap(
    services: BootstrapServices,
    company: { id: string; name?: string; emailDomain?: string | null },
    user: { id: string; email: string | null; name?: string | null },
    // AgentDash (scan 2, E3): set when this call created the CoS, so only the
    // user it was created for is paired with it.
    outcome: { createdCos: boolean } = { createdCos: false },
  ): Promise<BootstrapResult> {
    const currentMemberships = await services.access.listUserCompanyAccess(user.id);
    const existingMembership = currentMemberships.find((m: any) => m.companyId === company.id);
    const hasActiveMembership = existingMembership?.status === "active";
    // AgentDash (security, PR #956 review): a suspended or pending membership
    // is never reactivated here. Only a person with no membership row at all
    // gets one (the new-workspace and corp-domain paths).
    if (existingMembership && !hasActiveMembership) {
      throw forbidden("Your access to this workspace is not active.");
    }

    // Step 3 needs the current agent list under the same capacity lock. That
    // makes concurrent bootstrap calls observe any CoS created by the previous
    // transaction before deciding whether this request consumes the free agent
    // slot.
    const existing = (await services.agents.list?.(company.id)) ?? [];
    let cos = existing.find((a: any) => a.role === "chief_of_staff");

    await assertBootstrapTierCapacity(services, company.id, {
      humans: hasActiveMembership ? 0 : 1,
      agents: cos ? 0 : 1,
    });

    // Step 2: membership, then the agents:create grant (GH #72).
    // AgentDash (security, PR #956 review): owner only for a brand-new
    // membership. ensureMembership REWRITES an existing row's role, which let a
    // viewer or member who called bootstrap become owner; an existing
    // membership is left exactly as it is (never upgraded or downgraded).
    if (!existingMembership) {
      await services.access.ensureMembership(company.id, "user", user.id, "owner", "active");
    }
    // AgentDash (scan 3, lane H): setPrincipalPermission no longer touches an
    // existing membership. It used to upsert `member`, which demoted a founder
    // who created the company at /company-create the moment they opened /cos.
    await services.access.setPrincipalPermission(
      company.id,
      "user",
      user.id,
      "agents:create",
      true,
      user.id,
    );

    // Step 3: ensure a Chief of Staff agent exists.
    if (!cos) {
      outcome.createdCos = true;
      const created = await services.agents.create(company.id, {
        name: "Chief of Staff",
        role: "chief_of_staff",
        adapterType: (process.env.AGENTDASH_DEFAULT_ADAPTER ?? "claude_local").trim() || "claude_local",
        adapterConfig: {},
        status: "idle",
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      });
      // Materialize the standard agent bundle (one archetype for every role —
      // see default-agent-instructions.ts for why the CEO persona is gone).
      const bundleFiles = await loadDefaultAgentInstructionsBundle("default");
      const materialized = await services.instructions.materializeManagedBundle(
        created,
        bundleFiles,
        { entryFile: "AGENTS.md", replaceExisting: false },
      );
      cos = { ...created, adapterConfig: materialized.adapterConfig };
    }

    // Step 4: ensure CoS has an API key (carry from GH #71 — but POST handler creates it; here we
    // need to make sure it exists if the agent was created by another path).
    // For idempotency simplicity: just always ensure one key exists.
    const existingKeys = (await services.agents.listKeys?.(cos.id)) ?? [];
    if (existingKeys.length === 0) {
      await services.agents.createApiKey(cos.id, "default", { source: "onboarding" });
    }

    // Step 5: ensure a conversation exists for this company; add the user as participant.
    // The fresh-conversation branch is the atomic point: conversations.create only
    // succeeds once per workspace, so we post the welcome sequence here. This
    // eliminates the read-then-write race that the old route-handler check had.
    let conversation = await services.conversations.findByCompany(company.id);
    const isFreshConversation = !conversation;
    if (!conversation) {
      conversation = await services.conversations.create({ companyId: company.id, userId: user.id });
    }
    await services.conversations.addParticipant(conversation.id, user.id, "owner");
    if (isFreshConversation) {
      await postWelcomeSequence(services.conversations, conversation.id, cos.id, user.name, company.name);
    }

    logger.info({ userId: user.id, companyId: company.id, cosAgentId: cos.id, conversationId: conversation.id }, "onboarding bootstrap complete");

    return {
      companyId: company.id,
      cosAgentId: cos.id,
      conversationId: conversation.id,
    };
  }

  return {
    bootstrap: async (
      userId: string,
      options: { companyId?: string | null; actorIsInstanceAdmin?: boolean; strictCompanyId?: boolean } = {},
    ): Promise<BootstrapResult> => {
      // Try the real auth_users lookup first; fall back to local-trusted sentinel.
      const user = (await deps.users.getById(userId)) ?? resolveLocalUser(userId);
      if (!user) throw new Error(`User ${userId} not found`);

      // Step 1: ensure a company.
      // Idempotency is per-user, not per-domain: if this user already belongs to
      // a company (e.g. bootstrap() fired twice from auth hook + CoSConversation
      // useEffect), reuse their first active membership rather than creating a
      // second workspace. We intentionally do NOT look up by email domain —
      // domain matching caused all gmail.com users to land in the same workspace,
      // which is a critical isolation bug.
      //
      // Use `deriveCompanyEmailDomain` from @paperclipai/shared rather than the
      // local `deriveEmailDomain` helper. For free-mail providers (gmail/yahoo/
      // outlook/...) the shared helper returns `local@domain` — a per-user
      // workspace key — so the unique constraint on companies.emailDomain
      // doesn't collide between unrelated personal accounts that happen to
      // share a domain. The local helper returns just `gmail.com`, which makes
      // any second gmail.com user's bootstrap throw "domain already claimed".
      let emailDomain: string | null = null;
      if (user.email) {
        try {
          emailDomain = deriveCompanyEmailDomain(user.email);
        } catch {
          // Falls through with emailDomain = null. The DB column allows null;
          // workspace creation still succeeds for emails the helper can't
          // parse (e.g. the synthetic local-board actor in local_trusted mode).
        }
      }
      const existingMemberships = await deps.access.listUserCompanyAccess(userId);
      // AgentDash (one onboarding path): "New Company" on a self-hosted
      // instance names a second workspace at /company-create and then opens
      // /cos for it. The caller names that workspace; it is used only when
      // this user is an active member of it, otherwise the call is refused
      // below. Without a companyId the first active membership is reused.
      const requestedMembership = options.companyId
        ? existingMemberships.find(
            (m: any) => m.status === "active" && m.companyId === options.companyId,
          )
        : undefined;
      // AgentDash (PR #956 review): a named workspace is never swapped for
      // another one. Falling back to the first membership let /cos render the
      // wrong company's chat. Refused before anything is written: 403 on
      // every route, 400 on the assessment route (strictCompanyId), which
      // validates its own body. No companyId keeps the legacy behaviour.
      // Instance admins do NOT bypass this (PR #959 review): a CoS is never
      // created in a workspace the caller does not belong to.
      if (options.companyId && !requestedMembership) {
        const message = "You are not an active member of that workspace.";
        if (options.strictCompanyId) throw badRequest(message);
        throw new HttpError(403, message, { code: "not_a_member" }, "not_a_member");
      }
      const activeMemberships = existingMemberships.filter(
        (m: any) => m.status === "active",
      );
      // AgentDash (security, GH #977): without a companyId, inferring from
      // the first active membership guesses between companies the caller may
      // not have meant (the Ask page created a CoS in the other workspace).
      // More than one candidate is a conflict the caller must resolve by
      // naming the company — exactly one is still inferred.
      if (!options.companyId && activeMemberships.length > 1) {
        const candidates = await Promise.all(
          activeMemberships.map(async (membership: any) => {
            const found = await deps.companies
              .getById(membership.companyId)
              .catch(() => null);
            return {
              id: membership.companyId as string,
              name: (found as { name?: string | null } | null)?.name ?? null,
            };
          }),
        );
        throw new AmbiguousWorkspaceBootstrapError(candidates);
      }
      const activeMembership = requestedMembership ?? activeMemberships[0];
      let company: { id: string; name?: string; emailDomain?: string | null };
      if (activeMembership) {
        // Returning user — reuse the workspace they already belong to.
        // AgentDash (security, PR #956 review): setting up a workspace's CoS
        // (agent, API key, conversation) is an owner/admin act. A viewer or
        // member is refused here instead of being set up — and, before this
        // fix, promoted to owner. The local-board actor (local_trusted) and
        // instance admins qualify.
        const mayBootstrap =
          normalizeHumanRole(activeMembership.membershipRole) === "admin" ||
          userId === LOCAL_BOARD_USER_ID ||
          options.actorIsInstanceAdmin === true;
        if (!mayBootstrap) {
          throw forbidden("Only a workspace owner or admin can set up the Chief of Staff.");
        }
        const found = await deps.companies.getById(activeMembership.companyId);
        if (!found) throw new Error(`Company ${activeMembership.companyId} not found for existing membership`);
        if ((found as { status?: string }).status === "archived") {
          throw conflict("This workspace is archived.");
        }
        company = found;
      } else {
        // First sign-up for this user. Create a fresh workspace, unless a
        // same-domain workspace already exists (corp pattern), which is
        // refused below: coworkers join by invite, not by email domain.
        //
        // The discriminator is the shape of `emailDomain` after
        // `deriveCompanyEmailDomain`:
        //   - free-mail (gmail/yahoo/outlook/…): "<local>@<domain>" —
        //     unique per user, so even if a same-provider user already
        //     exists their key won't collide. We always create fresh.
        //   - corp (acme.com / yourstartup.io / …): "<domain>" —
        //     shared across all users at that domain; an existing workspace
        //     for it means "contact your administrator", as POST /companies
        //     answers.
        //
        // The free-mail key contains "@", corp keys don't — that's the
        // detection. Falls back to fresh workspace if `emailDomain` is
        // unset (synthetic local-board actor / unparseable email).
        const isCorpDomain =
          typeof emailDomain === "string" && emailDomain.length > 0 && !emailDomain.includes("@");
        const corpExisting = isCorpDomain && deps.companies.findByEmailDomain
          ? await deps.companies.findByEmailDomain(emailDomain)
          : null;
        if (corpExisting) {
          // AgentDash (security, PR #956 re-review): no auto-join. This path
          // used to make a same-domain stranger owner of the existing
          // workspace, grant agents:create and set up a CoS. Joining an
          // existing workspace is by invite, which is what POST /companies
          // already tells the same person (domain_already_claimed, "Contact
          // your administrator to join it"). Nothing is written here.
          throw new HttpError(
            409,
            "A workspace for this email domain already exists. Contact your administrator to join it.",
            { existingCompanyId: corpExisting.id },
            "domain_already_claimed",
          );
        } else {
          // AgentDash (#102): single-workspace-per-self-hosted-installation guard.
          // Self-hosted operators should only have one workspace — the installation IS the
          // company. Bypassed when: AGENTDASH_ALLOW_MULTI_COMPANY env var is set, or
          // local_trusted + AGENTDASH_DEV_MODE.
          if (!isSingleCompanyOverrideActive()) {
            const hasExisting = await deps.companies.hasActiveCompany();
            if (hasExisting) {
              const first = await deps.companies.list().then((cs: any[]) => cs[0] ?? null);
              throw new SingleCompanyInstallationError(first?.id ?? null);
            }
          }
          company = await deps.companies.create({
            name: companyNameFromEmail(user.email),
            emailDomain,
            budgetMonthlyCents: 0,
          });
          // AgentDash: self-serve-bootstrap. A founder who opens /cos before
          // /company-create gets the box's first company HERE, so this path
          // must make them instance admin exactly as POST /companies does.
          // The shared rule no-ops for the local-board actor, when the flag
          // is off, and unless this is the box's first company.
          if (process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP === "true") {
            await deps.access.promoteSelfServeBootstrapAdmin(user.id, company.id);
          }
        }
      }

      const outcome = { createdCos: false };
      const result = deps.tierCapacity
        ? await deps.tierCapacity.withCompanyLock(company.id, (services) =>
            finalizeBootstrap(services, company, user, outcome),
          )
        : await finalizeBootstrap(deps, company, user, outcome);
      // AgentDash (scan 2, E3): the company's owner stewards the Chief of
      // Staff made for them, on every workspace. Paired only when this call
      // created the CoS AND the bootstrapping user holds the company's `owner`
      // membership (pairFounderWithAgent checks; an admin who bootstraps /cos
      // is not paired). It only writes a stewardship row, never a membership
      // or role. After the capacity transaction, so a refused pairing can
      // never abort the bootstrap; best-effort inside.
      if (deps.stewardships && outcome.createdCos) {
        await pairFounderWithAgent(deps.stewardships, {
          companyId: result.companyId,
          agentId: result.cosAgentId,
          userId: user.id,
        });
      }
      return result;
    },
  };
}

function deriveEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

function companyNameFromEmail(email: string | null | undefined): string {
  const domain = deriveEmailDomain(email);
  if (!domain) return "My Workspace";
  // AgentDash bootstrap: the local-trusted seed email lives at agentdash.local
  // and "Agentdash" (lower 'd') reads off-brand. Map it to the proper casing.
  if (domain === "agentdash.local") return "AgentDash Workspace";
  const root = domain.split(".")[0];
  return root.charAt(0).toUpperCase() + root.slice(1);
}

