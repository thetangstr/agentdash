/**
 * AgentDash (batch 4, c4-model-tiers): operator repair that brings existing
 * `hermes_local` agents onto the shipped high–low model tiers.
 *
 * Creation now stamps the role's tier model/provider onto a hermes_local
 * agent with no explicit model (see packages/shared hermes-model-tiers.ts).
 * Agents created before that landed have an empty `adapterConfig.model` and
 * fall back to whatever their Hermes config happens to say — for most
 * deployments that is the old GLM default. This command moves them onto the
 * tier their role maps to: Qwen 3.8 Max for leadership, DeepSeek V4.1 Flash
 * for everyone else, both on the `alibaba-token-plan-cn` provider.
 *
 * It is deliberately a dry run first. Without --apply it only lists, per
 * agent, the current provider/model and the proposed one. With --apply it
 * writes the tier's `model` (and `provider` when none is set) into
 * adapterConfig, records the tier in `agent.metadata.modelTier` — the same
 * provenance creation writes — and logs an `agent.model_tier_applied`
 * activity row per changed agent with this command as the actor.
 *
 * An explicit `adapterConfig.model` is a choice a person made; the command
 * lists it as kept and never overwrites it. An explicit `provider` that is
 * not the tier's is a choice too — the agent is kept whole rather than
 * given a tier model on someone else's provider. If the model happens to
 * be one of the tier ids already, the agent is shown as already on its
 * tier.
 *
 * BYOK: on a box where a company configured its own provider key (the
 * marker `configureHermesProvider` writes into the template profile), the
 * tiers must never apply — the same rule creation and dispatch follow.
 * A dry run still lists the agents; --apply refuses.
 *
 * Harness preflight: the readiness digest is computed over adapterConfig
 * (see server/src/services/agent-harness-preflight-readiness.ts), so every
 * changed agent's stored preflight goes stale on write and the agent is
 * marked for a re-check the next time readiness is evaluated — no separate
 * flag is needed.
 */
import * as p from "@clack/prompts";
import pc from "picocolors";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, ne } from "drizzle-orm";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import {
  AGENT_MODEL_TIER_METADATA_KEY,
  applyHermesModelTierDefault,
  HERMES_LOCAL_ADAPTER_TYPE,
  isUuidLike,
  modelTierForRole,
  resolveHermesModelTier,
  type HermesModelTierId,
} from "@paperclipai/shared";
import { loadPaperclipEnvFile } from "../config/env.js";
import { resolveConfigPath } from "../config/store.js";
import { resolveDbUrl } from "./auth-bootstrap-ceo.js";
import { currentOperator, type RepairOperator } from "./repair-founder-owner.js";

type Db = ReturnType<typeof createDb>;
type Reader = Pick<Db, "select">;

export const MODEL_TIERS_ACTOR_ID = "cli:doctor apply-model-tiers";

export type ModelTierPlanAction = "fill" | "explicit_kept" | "already_on_tier" | "terminated";

export interface AgentModelTierPlan {
  agentId: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  tier: HermesModelTierId;
  current: { model: string | null; provider: string | null };
  proposed: { model: string; provider: string };
  action: ModelTierPlanAction;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The dry-run plan for every hermes_local agent in a company: what it runs
 * today and what the tier for its role would put there.
 */
export async function planModelTiers(db: Reader, companyId: string): Promise<AgentModelTierPlan[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      title: agents.title,
      status: agents.status,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.adapterType, HERMES_LOCAL_ADAPTER_TYPE)))
    .orderBy(asc(agents.createdAt));

  return rows.map((row) => {
    const config = asRecord(row.adapterConfig) ?? {};
    const tier = modelTierForRole(row.role, row.title);
    const spec = resolveHermesModelTier(tier);
    const currentModel = nonEmpty(config.model);
    const currentProvider = nonEmpty(config.provider);
    // Review-1028 (item 3): an explicit provider that is not the tier's is
    // an explicit choice — same rule applyHermesModelTierDefault follows —
    // so the dry run and --apply agree on what would change.
    const action: ModelTierPlanAction =
      row.status === "terminated"
        ? "terminated"
        : currentModel === null
          ? currentProvider !== null && currentProvider !== spec.provider
            ? "explicit_kept"
            : "fill"
          : currentModel === spec.model
            ? "already_on_tier"
            : "explicit_kept";
    return {
      agentId: row.id,
      name: row.name,
      role: row.role,
      title: row.title,
      status: row.status,
      tier,
      current: { model: currentModel, provider: currentProvider },
      proposed: { model: spec.model, provider: spec.provider },
      action,
    };
  });
}

/**
 * Apply the plan: fill model (and provider when empty) on every agent that
 * has no explicit model, stamp `metadata.modelTier`, and audit each change.
 * Changing adapterConfig makes the stored harness-preflight digest stale,
 * which is what marks the agent for a re-check.
 */
export async function applyModelTiers(
  db: Db,
  input: { companyId: string; operator?: RepairOperator },
): Promise<{ applied: AgentModelTierPlan[]; skipped: AgentModelTierPlan[] }> {
  const operator = input.operator ?? currentOperator();
  return db.transaction(async (tx) => {
    const plan = await planModelTiers(tx, input.companyId);
    const applied: AgentModelTierPlan[] = [];
    const skipped: AgentModelTierPlan[] = [];
    for (const item of plan) {
      if (item.action !== "fill") {
        skipped.push(item);
        continue;
      }
      const [row] = await tx
        .select({ adapterConfig: agents.adapterConfig, metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, item.agentId))
        .for("update");
      if (!row) {
        skipped.push(item);
        continue;
      }
      const tiered = applyHermesModelTierDefault({
        adapterType: HERMES_LOCAL_ADAPTER_TYPE,
        adapterConfig: asRecord(row.adapterConfig) ?? {},
        role: item.role,
        title: item.title,
      });
      if (!tiered.appliedTier) {
        // Another writer set a model between plan and apply — it is now an
        // explicit config and wins by the same rule creation uses.
        skipped.push(item);
        continue;
      }
      const metadata = {
        ...(asRecord(row.metadata) ?? {}),
        [AGENT_MODEL_TIER_METADATA_KEY]: tiered.appliedTier,
      };
      await tx
        .update(agents)
        .set({ adapterConfig: tiered.adapterConfig, metadata, updatedAt: new Date() })
        .where(eq(agents.id, item.agentId));
      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: MODEL_TIERS_ACTOR_ID,
        action: "agent.model_tier_applied",
        entityType: "agent",
        entityId: item.agentId,
        agentId: item.agentId,
        details: {
          tier: item.tier,
          from: item.current,
          to: {
            model: nonEmpty(tiered.adapterConfig.model),
            provider: nonEmpty(tiered.adapterConfig.provider),
          },
          reason: "hermes_local model-tier backfill (doctor apply-model-tiers)",
          harnessPreflight: "marked for re-check (adapterConfig digest changed)",
          operator: { osUser: operator.osUser, host: operator.host },
        },
      });
      applied.push(item);
    }
    return { applied, skipped };
  });
}

function describePlan(item: AgentModelTierPlan): string {
  const current = `${item.current.provider ?? "—"}/${item.current.model ?? "—"}`;
  const proposed = `${item.proposed.provider}/${item.proposed.model}`;
  const who = `${item.name} (${item.role}${item.title ? `, ${item.title}` : ""})`;
  switch (item.action) {
    case "fill":
      return `  ${pc.yellow("fill")}      ${who}\n             ${current} → ${pc.green(proposed)}  [${item.tier} tier]`;
    case "already_on_tier":
      return `  ${pc.green("on tier")}   ${who}\n             ${current}  already on the ${item.tier} tier`;
    case "explicit_kept":
      return `  ${pc.cyan("explicit")}  ${who}\n             ${current}  kept — an explicit model or provider always wins (tier would be ${proposed})`;
    case "terminated":
      return `  ${pc.gray("terminated")} ${who}\n             ${current}  skipped`;
  }
}

/**
 * Mirrors `hermesProviderConfiguredSync` in
 * server/src/services/hermes-provider-setup.ts: true when a company has
 * configured its own provider key through the model-key setup — the marker
 * in `<profiles>/<template>/agentdash-provider.json`. The paths follow the
 * same env vars (AGENTDASH_HERMES_ROOT, HERMES_PROFILES_DIR,
 * AGENTDASH_HERMES_PROFILE_TEMPLATE). On a BYOK box the tiers must never
 * apply, so --apply refuses and a dry run warns.
 */
const BYOK_MARKER_PROVIDERS = new Set(["zai", "openrouter", "anthropic", "openai"]);

function byokProviderMarkerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const root = (env.AGENTDASH_HERMES_ROOT ?? "").trim() || join(homedir(), ".hermes");
  const profilesDir = (env.HERMES_PROFILES_DIR ?? "").trim() || join(root, "profiles");
  const template = (env.AGENTDASH_HERMES_PROFILE_TEMPLATE ?? "").trim() || "agentdash";
  try {
    const raw = JSON.parse(
      readFileSync(join(profilesDir, template, "agentdash-provider.json"), "utf8"),
    );
    return BYOK_MARKER_PROVIDERS.has(raw?.provider);
  } catch {
    return false;
  }
}

export async function applyModelTiersCommand(opts: {
  config?: string;
  dbUrl?: string;
  company?: string;
  apply?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);
  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error("Could not resolve the database connection. Set DATABASE_URL or pass --db-url.");
    process.exitCode = 1;
    return;
  }
  if (!opts.company) {
    p.log.error("--company <id> is required. Run it to list the proposed changes first.");
    process.exitCode = 1;
    return;
  }
  if (!isUuidLike(opts.company)) {
    p.log.error(`--company expects the company's UUID, got "${opts.company}".`);
    process.exitCode = 1;
    return;
  }
  const byok = byokProviderMarkerConfigured();
  if (byok && opts.apply) {
    p.log.error(
      "This box holds a company's own model provider key (the agentdash-provider.json marker in the "
        + "Hermes template profile). The tiers must never apply on a BYOK box — the same rule "
        + "creation and CoS dispatch follow. Remove the marker or run this on a token-plan box.",
    );
    process.exitCode = 1;
    return;
  }
  const db = createDb(dbUrl);
  const closable = db as typeof db & { $client?: { end?: (o?: { timeout?: number }) => Promise<void> } };
  try {
    const [company] = await db
      .select({ id: companies.id, name: companies.name, status: companies.status })
      .from(companies)
      .where(and(eq(companies.id, opts.company), ne(companies.status, "archived")));
    if (!company) {
      p.log.error("No active company with that id.");
      process.exitCode = 1;
      return;
    }
    if (byok) {
      p.log.warn(
        "BYOK marker present — this box runs on a company's own provider key; the tier plan "
          + "below is informational only and --apply would refuse here.",
      );
    }
    const plan = await planModelTiers(db, opts.company);
    p.log.info(`${pc.bold(company.name)} (${company.id}): ${plan.length} hermes_local agent(s)`);
    for (const item of plan) p.log.message(describePlan(item));
    const fillCount = plan.filter((item) => item.action === "fill").length;
    if (!opts.apply) {
      p.log.info(
        fillCount > 0
          ? `Dry run. ${fillCount} agent(s) would move to their role's tier: ${pc.cyan("--apply")} to write.`
          : "Dry run. Nothing to change — every agent is on a tier or on an explicit model.",
      );
      return;
    }
    const { applied, skipped } = await applyModelTiers(db, { companyId: opts.company });
    if (applied.length > 0) {
      p.log.success(
        `Applied model tiers to ${applied.length} agent(s); ${skipped.length} unchanged. `
          + "Each changed agent's stored harness preflight is now stale — run a re-check before the next launch.",
      );
    } else {
      p.log.info("Nothing changed — no agent needed a tier.");
    }
  } finally {
    await closable.$client?.end?.({ timeout: 5 });
  }
}
