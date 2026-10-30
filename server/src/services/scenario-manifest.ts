import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentProfiles, agents, issues } from "@paperclipai/db";
import {
  AGENT_SCENARIO_MANIFEST_DOCUMENT_KEY,
  AGENT_SCENARIO_MANIFEST_INVALID,
  AGENT_WORK_BRIEF_ORIGIN_KIND,
  parseAgentScenarioManifestDocument,
  type AgentScenarioManifestIssue,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

/**
 * AgentDash: Agent Performance Management gate 5 (P5.1) — the scenario
 * manifest is validated on every write of the `scenario-manifest` document
 * of an issue created as a brief (`origin_kind = agent_work_brief`). Called
 * from the document service, so the issue route, its restore, plugins and
 * steward replies all pass the same check. Any other issue's document of
 * that key is an ordinary document.
 *
 * Invalid (422 `AGENT_SCENARIO_MANIFEST_INVALID`, with the issues listed):
 * - not JSON (or one ```json block), or not `AgentScenarioManifestV1`;
 * - a `targetAgentId` that is not an agent of the issue's company;
 * - an `unboundProfileId` that is not a profile of the issue's company.
 * Ids are checked company-scoped only: the manifest never refers outside it.
 */

type ReadDb = Pick<Db, "select">;

/** True when this write must be validated as a manifest. */
export function isScenarioManifestWrite(issue: { originKind?: string | null }, key: string): boolean {
  return key === AGENT_SCENARIO_MANIFEST_DOCUMENT_KEY && issue.originKind === AGENT_WORK_BRIEF_ORIGIN_KIND;
}

/** The issue's origin, for callers that loaded only its id. */
export async function loadIssueOrigin(db: ReadDb, issueId: string): Promise<{ id: string; companyId: string; originKind: string } | null> {
  return db
    .select({ id: issues.id, companyId: issues.companyId, originKind: issues.originKind })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
}

/** Throws 422 unless `body` is a valid manifest for `companyId`. */
export async function assertScenarioManifestBody(db: ReadDb, companyId: string, body: string): Promise<void> {
  const parsed = parseAgentScenarioManifestDocument(body);
  if (!parsed.ok) throw invalid(parsed.issues);
  const issues: AgentScenarioManifestIssue[] = [];
  const scenarios = parsed.manifest.scenarios;
  const agentIds = [...new Set(scenarios.flatMap((scenario) => (scenario.targetAgentId ? [scenario.targetAgentId] : [])))];
  const profileIds = [...new Set(scenarios.flatMap((scenario) => (scenario.unboundProfileId ? [scenario.unboundProfileId] : [])))];
  const [knownAgents, knownProfiles] = await Promise.all([
    agentIds.length > 0
      ? db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
          .then((rows) => new Set(rows.map((row) => row.id)))
      : Promise.resolve(new Set<string>()),
    profileIds.length > 0
      ? db
          .select({ id: agentProfiles.id })
          .from(agentProfiles)
          .where(and(eq(agentProfiles.companyId, companyId), inArray(agentProfiles.id, profileIds)))
          .then((rows) => new Set(rows.map((row) => row.id)))
      : Promise.resolve(new Set<string>()),
  ]);
  scenarios.forEach((scenario, index) => {
    if (scenario.targetAgentId && !knownAgents.has(scenario.targetAgentId)) {
      issues.push({ path: `scenarios.${index}.targetAgentId`, message: "not an agent of this company" });
    }
    if (scenario.unboundProfileId && !knownProfiles.has(scenario.unboundProfileId)) {
      issues.push({ path: `scenarios.${index}.unboundProfileId`, message: "not a draft profile of this company" });
    }
  });
  if (issues.length > 0) throw invalid(issues);
}

/** The document-service hook: validates only a brief's `scenario-manifest`. */
export async function assertScenarioManifestWrite(
  db: ReadDb,
  issue: { companyId: string; originKind?: string | null },
  key: string,
  body: string,
): Promise<void> {
  if (!isScenarioManifestWrite(issue, key)) return;
  await assertScenarioManifestBody(db, issue.companyId, body);
}

function invalid(issues: AgentScenarioManifestIssue[]) {
  return unprocessable("The scenario manifest is not valid", { code: AGENT_SCENARIO_MANIFEST_INVALID, issues });
}
