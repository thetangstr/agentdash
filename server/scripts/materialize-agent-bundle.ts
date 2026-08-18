/**
 * Give an existing agent the instruction bundle its role should have shipped
 * with — the mandate it reads to know who it is and what it may do.
 *
 * The problem this solves: `bootstrap()` materializes a bundle for the Chief of
 * Staff it creates, and agent creation materializes one for agents created
 * through the proposal flow. An agent created any OTHER way — the New Agent
 * form, a direct insert, a path that predates the default-bundle map — gets no
 * bundle at all. Nothing errors. The agent simply has no AGENTS.md, so
 * `agentdashGetAgentDirectives` returns nothing and the agent runs with no
 * mandate, which is indistinguishable from a mandate that says "do anything".
 *
 * Found on the design partner's board 2026-08-17: `Casper` (role `ceo`) had an
 * adapterConfig of empty strings, no bundle keys, zero directives and zero
 * goals, on an instance that had never recorded a heartbeat run.
 *
 * This is deliberately NOT `agent-instruction-refresh`. That service updates
 * `<!-- AgentDash: SLUG -->` blocks inside a bundle that already exists; it has
 * nothing to refresh when there is no bundle. This does the initial
 * materialization, using the same call bootstrap uses, so an agent fixed here
 * is afterwards indistinguishable from one that was created correctly.
 *
 * The env file selects the workspace, because DATABASE_URL is what decides
 * whether you just wrote a mandate onto the real board or the practice one:
 *
 *   cd ~/agentdash/server
 *   set -a && . ~/.config/agentdash/mkboard.env && set +a
 *   pnpm exec tsx scripts/materialize-agent-bundle.ts Casper --dry-run
 *   pnpm exec tsx scripts/materialize-agent-bundle.ts Casper
 *
 * Accepts an agent id or an exact name. Refuses by default when a bundle is
 * already present, because overwriting a mandate someone hand-edited is a
 * different and much less welcome operation than filling in a missing one —
 * pass --force for that, and read the diff first.
 */

import { createDb, agents as agentsTable } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.js";
import { agentService } from "../src/services/agents.js";
import { agentInstructionsService } from "../src/services/agent-instructions.js";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../src/services/default-agent-instructions.js";
import { logActivity } from "../src/services/activity-log.js";

const args = process.argv.slice(2);
const selector = args.find((a) => !a.startsWith("--"))?.trim();
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");

// There used to be an --archetype flag here, working around role-selected
// persona mandates (`ceo` / `chief_of_staff`). Those archetypes are gone --
// every agent gets the one steward-centric bundle -- so the flag is too.

if (!selector) {
  console.error("usage: pnpm exec tsx scripts/materialize-agent-bundle.ts <agent-id|agent-name> [--dry-run] [--force]");
  console.error("  source the instance env file first — DATABASE_URL selects the workspace");
  process.exit(64); // EX_USAGE
}

const config = loadConfig();
const workspace = config.databaseUrl.split("/").pop() ?? "unknown";
const db = createDb(config.databaseUrl);
const svc = agentService(db as never);
const instructions = agentInstructionsService();

const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selector);
const found = await db
  .select()
  .from(agentsTable)
  .where(isUuid ? eq(agentsTable.id, selector) : eq(agentsTable.name, selector));

if (found.length === 0) {
  console.error(`no agent matching '${selector}' in workspace '${workspace}'`);
  process.exit(1);
}
if (found.length > 1) {
  // Names are not unique. Refuse rather than guess which mandate to write.
  console.error(`'${selector}' matches ${found.length} agents in workspace '${workspace}'. Pass an id:`);
  for (const a of found) console.error(`  ${a.id}  role=${a.role}  status=${a.status}`);
  process.exit(1);
}

const agent = found[0]!;
const existing = await instructions.getBundle(agent);
const hasBundle = Boolean(existing.rootPath) && existing.files.length > 0;

const bundleRole = resolveDefaultAgentInstructionsBundleRole(agent.role);
const files = await loadDefaultAgentInstructionsBundle(bundleRole);

console.log("");
console.log(`  agent      ${agent.name}  (${agent.id})`);
console.log(`  workspace  ${workspace}`);
console.log(`  role       ${agent.role}  ->  '${bundleRole}' bundle`);
console.log(`  files      ${Object.keys(files).join(", ")}`);
console.log(`  current    ${hasBundle ? `${existing.files.length} file(s) at ${existing.rootPath}` : "no bundle"}`);

if (hasBundle && !force) {
  console.error("");
  console.error("  refusing: this agent already has a bundle. Inspect it first, then re-run with --force.");
  process.exit(1);
}

if (dryRun) {
  console.log("");
  console.log("  --dry-run: nothing written.");
  process.exit(0);
}

const { bundle, adapterConfig } = await instructions.materializeManagedBundle(
  agent,
  files,
  { entryFile: "AGENTS.md", replaceExisting: force },
);

// Persist through the service with a config revision, exactly as
// `PATCH /agents/:id/instructions-bundle` does — a mandate that appears with no
// audit trail is worse than one that is missing, because nobody can tell where
// it came from. Secret normalization is skipped deliberately: these bundle keys
// are paths, and this script never introduces an `env` block.
await svc.update(
  agent.id,
  { adapterConfig },
  {
    recordRevision: {
      createdByAgentId: null,
      createdByUserId: null,
      source: "instructions_bundle_backfill",
    },
  },
);

// `activity_log.actor_id` is NOT NULL, and the convention for a non-human
// actor is a descriptive slug naming what did it (see
// agent-instruction-refresh.ts) rather than a null or a bare "system".
try {
  await logActivity(db, {
    companyId: agent.companyId,
    actorType: "system",
    actorId: "materialize-agent-bundle-script",
    agentId: agent.id,
    runId: null,
    action: "agent.instructions_bundle_updated",
    entityType: "agent",
    entityId: agent.id,
    details: {
      mode: bundle.mode,
      rootPath: bundle.rootPath,
      entryFile: bundle.entryFile,
      source: "materialize-agent-bundle script",
      role: bundleRole,
      replacedExisting: force,
    },
  });
} catch (error) {
  // The bundle is already on disk and the config is already persisted by this
  // point. Crashing here reports the whole operation as failed when the part
  // that matters succeeded -- which is precisely what happened the first time
  // this ran, and it cost a round of confusion about whether Casper had a
  // mandate or not. Say exactly what is true and exit non-zero.
  console.error("");
  console.error("  WARNING: the bundle WAS written and the agent config WAS updated,");
  console.error("  but the activity-log entry failed. The change is live and unaudited:");
  console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// Read back from disk rather than trusting the return value: the bundle only
// counts if the agent can actually read it on its next run.
const readBack = await instructions.getBundle(agent);
console.log("");
console.log(`  wrote      ${readBack.files.length} file(s) to ${readBack.rootPath}`);
console.log(`  entry      ${readBack.entryFile}  (mode: ${readBack.mode})`);
for (const f of readBack.files) {
  console.log(`               ${f.path}  ${f.size} bytes`);
}
console.log("");
process.exit(0);
