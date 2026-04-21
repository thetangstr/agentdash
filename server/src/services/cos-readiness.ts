// AgentDash (AGE-50 Phase 1): readiness check for goal creation.
//
// A goal without a plan-generation path is worse than no goal — the
// auto-propose flow (AGE-48) and the Socratic interview flow (AGE-50)
// both assume the company has (a) an active Chief of Staff agent and
// (b) an adapter that can actually run the CoS. If either is missing,
// NewGoalDialog blocks submission and surfaces a CTA that routes the
// operator to the hire/config flow.
//
// We treat `adapter_type='process'` as "not real" — that's the schema
// default placeholder, not a configured runtime. Any other adapter
// string (claude_api, claude_local, codex, gemini, …) counts as a
// configured path.

import { and, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { agents } from "@agentdash/db";

export interface CosReadiness {
  ready: boolean;
  hasChiefOfStaff: boolean;
  hasLlmAdapter: boolean;
  reasons: string[];
  chiefOfStaffAgentId: string | null;
}

const PLACEHOLDER_ADAPTER = "process";
// Agents in these statuses are hired and configured but not blocked — they
// can be triggered as part of a plan flow. Terminal / gated statuses
// (pending_approval, paused, error, terminated) are treated as not ready.
const READY_STATUSES = new Set(["active", "idle", "running"]);

export function cosReadinessService(db: Db) {
  return {
    async check(companyId: string): Promise<CosReadiness> {
      const rows = await db
        .select({
          id: agents.id,
          adapterType: agents.adapterType,
          status: agents.status,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.role, "chief_of_staff")));

      const active = rows.filter((r) => READY_STATUSES.has(r.status));
      const hasChiefOfStaff = active.length > 0;

      const cos = active.find((r) => r.adapterType && r.adapterType !== PLACEHOLDER_ADAPTER) ?? null;
      const hasLlmAdapter = Boolean(cos);

      const reasons: string[] = [];
      if (!hasChiefOfStaff) {
        reasons.push(
          "No active Chief of Staff agent. Hire one from the Agents sidebar before creating goals.",
        );
      } else if (!hasLlmAdapter) {
        reasons.push(
          "Chief of Staff has no runtime adapter configured. Open the agent and pick an adapter (Claude Code, Codex, Gemini, …).",
        );
      }

      return {
        ready: hasChiefOfStaff && hasLlmAdapter,
        hasChiefOfStaff,
        hasLlmAdapter,
        reasons,
        chiefOfStaffAgentId: cos?.id ?? active[0]?.id ?? null,
      };
    },
  };
}
