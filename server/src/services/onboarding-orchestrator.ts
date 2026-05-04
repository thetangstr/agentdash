import { logger } from "../middleware/logger.js";
import { deriveCompanyEmailDomain } from "@paperclipai/shared";

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

function buildPhase0Greeting(userName: string | null | undefined): string {
  const firstName = (userName ?? "").trim().split(/\s+/)[0] || null;
  const salutation = firstName ? `Hi ${firstName}!` : "Hi there!";
  return [
    `${salutation} I'm your Chief of Staff at AgentDash.`,
    `You're about to build out an AI workforce — agents that take on roles you'd normally hire employees for. My job is to figure out what kind of team you need and get them set up.`,
    `To start, tell me what you're trying to accomplish. What's your top short-term goal, and where do you want this to be in 6–12 months?`,
  ].join("\n\n");
}

async function postWelcomeSequence(
  conversations: any,
  conversationId: string,
  cosAgentId: string,
  userName: string | null | undefined,
): Promise<void> {
  await conversations.postMessage({
    conversationId,
    authorKind: "agent",
    authorId: cosAgentId,
    body: buildPhase0Greeting(userName),
  });
}

interface Deps {
  access: any;          // accessService(db)
  companies: any;       // companyService(db)
  agents: any;          // agentService(db)
  instructions: any;    // agentInstructionsService()
  conversations: any;   // conversationService(db)
  users: any;           // user lookup (auth-users service or direct query)
}

interface BootstrapResult {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
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
  return {
    bootstrap: async (userId: string): Promise<BootstrapResult> => {
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
      const activeMembership = existingMemberships.find(
        (m: any) => m.status === "active",
      );
      let company: { id: string; name?: string; emailDomain?: string | null };
      if (activeMembership) {
        // Returning user — reuse the workspace they already belong to.
        const found = await deps.companies.getById(activeMembership.companyId);
        if (!found) throw new Error(`Company ${activeMembership.companyId} not found for existing membership`);
        company = found;
      } else {
        // First sign-up for this user. Decide whether to attach to an
        // existing same-domain company (corp pattern) or create a fresh
        // workspace (free-mail pattern).
        //
        // The discriminator is the shape of `emailDomain` after
        // `deriveCompanyEmailDomain`:
        //   - free-mail (gmail/yahoo/outlook/…): "<local>@<domain>" —
        //     unique per user, so even if a same-provider user already
        //     exists their key won't collide. We always create fresh.
        //   - corp (acme.com / yourstartup.io / …): "<domain>" —
        //     shared across all users at that domain, so we attach to
        //     the existing workspace if any. Coworkers join their team
        //     by signing up with their work email.
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
          company = corpExisting;
        } else {
          company = await deps.companies.create({
            name: companyNameFromEmail(user.email),
            emailDomain,
            budgetMonthlyCents: 0,
          });
        }
      }

      // Step 2: grant agents:create FIRST (before owner promotion — see GH #72).
      await deps.access.setPrincipalPermission(
        company.id,
        "user",
        userId,
        "agents:create",
        true,
        userId,
      );
      await deps.access.ensureMembership(company.id, "user", userId, "owner", "active");

      // Step 3: ensure a Chief of Staff agent exists.
      const existing = (await deps.agents.list?.(company.id)) ?? [];
      let cos = existing.find((a: any) => a.role === "chief_of_staff");
      if (!cos) {
        const created = await deps.agents.create(company.id, {
          name: "Chief of Staff",
          role: "chief_of_staff",
          adapterType: (process.env.AGENTDASH_DEFAULT_ADAPTER ?? "claude_api").trim() || "claude_api",
          adapterConfig: {},
          status: "idle",
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        });
        // Materialize the default chief_of_staff bundle.
        const bundleFiles = await loadCosBundleFiles();
        const materialized = await deps.instructions.materializeManagedBundle(
          created,
          bundleFiles,
          { entryFile: "AGENTS.md", replaceExisting: false },
        );
        cos = { ...created, adapterConfig: materialized.adapterConfig };
      }

      // Step 4: ensure CoS has an API key (carry from GH #71 — but POST handler creates it; here we
      // need to make sure it exists if the agent was created by another path).
      // For idempotency simplicity: just always ensure one key exists.
      const existingKeys = (await deps.agents.listKeys?.(cos.id)) ?? [];
      if (existingKeys.length === 0) {
        await deps.agents.createApiKey(cos.id, "default");
      }

      // Step 5: ensure a conversation exists for this company; add the user as participant.
      // The fresh-conversation branch is the atomic point: conversations.create only
      // succeeds once per workspace, so we post the welcome sequence here. This
      // eliminates the read-then-write race that the old route-handler check had.
      let conversation = await deps.conversations.findByCompany(company.id);
      const isFreshConversation = !conversation;
      if (!conversation) {
        conversation = await deps.conversations.create({ companyId: company.id, userId });
      }
      await deps.conversations.addParticipant(conversation.id, userId, "owner");
      if (isFreshConversation) {
        await postWelcomeSequence(deps.conversations, conversation.id, cos.id, user.name);
      }

      logger.info({ userId, companyId: company.id, cosAgentId: cos.id, conversationId: conversation.id }, "onboarding bootstrap complete");

      return {
        companyId: company.id,
        cosAgentId: cos.id,
        conversationId: conversation.id,
      };
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

async function loadCosBundleFiles(): Promise<Record<string, string>> {
  // Read the four files from server/src/onboarding-assets/chief_of_staff/.
  // Use fs.readFile + path resolution relative to the compiled JS location.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, "../onboarding-assets/chief_of_staff");
  const files: Record<string, string> = {};
  for (const name of ["SOUL.md", "AGENTS.md", "HEARTBEAT.md", "TOOLS.md"]) {
    try {
      files[name] = await readFile(path.join(dir, name), "utf8");
    } catch {
      // missing files are tolerated; default fallback above
    }
  }
  return files;
}
