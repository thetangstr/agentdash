import { logger } from "../middleware/logger.js";

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

export function onboardingOrchestrator(deps: Deps) {
  return {
    bootstrap: async (userId: string): Promise<BootstrapResult> => {
      const user = await deps.users.getById(userId);
      if (!user) throw new Error(`User ${userId} not found`);

      // Step 1: ensure a company. Use email-domain lookup first (idempotency).
      const emailDomain = deriveEmailDomain(user.email);
      let company = emailDomain ? await deps.companies.findByEmailDomain(emailDomain) : null;
      if (!company) {
        company = await deps.companies.create({
          name: companyNameFromEmail(user.email),
          emailDomain,
          budgetMonthlyCents: 0,
        });
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
          adapterType: "claude_api",
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
      let conversation = await deps.conversations.findByCompany(company.id);
      if (!conversation) {
        conversation = await deps.conversations.create({ companyId: company.id, userId });
      }
      await deps.conversations.addParticipant(conversation.id, userId, "owner");

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
