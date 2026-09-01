/**
 * Remove last night's test data from the real workspace.
 *
 * The scenarios that proved the platform works left artefacts in `mkboard`:
 * two projects, thirteen issues, six synthetic company-context rows, and two
 * stand-in humans who exist only as database rows. They are all honestly
 * labelled, but "why does our board think we have a water campus project" is a
 * bad question to field in front of the client.
 *
 * ## Why this deletes through the API rather than with SQL
 *
 * `issues` is referenced by 25+ tables and several of those constraints are
 * NO ACTION -- `issue_comments`, `cost_events`, `finance_events`,
 * `feedback_votes`, `issue_read_states`. A hand-rolled `delete from projects`
 * either fails on a constraint or, worse, succeeds against a subset and leaves
 * rows pointing at nothing. `DELETE /api/projects/:id` already knows the
 * order; reusing it means this script cannot invent a cascade the application
 * disagrees with.
 *
 * Company-context rows have no dependents and are deleted directly.
 *
 * ## Safety
 *
 * Dry run unless you pass `--apply`. Takes a database backup first. Never
 * touches agents, goals, or the company itself.
 *
 *   node deploy/clean-test-data.mjs            # show what would go
 *   node deploy/clean-test-data.mjs --apply    # do it
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { readEnv, actAs, asPerson } from "../tests/manual-walkthrough/board-pack-lib.mjs";

const APPLY = process.argv.includes("--apply");
const INSTANCE = "mkboard";
const BASE = "http://127.0.0.1:3102";

/** Named explicitly. A pattern match would eventually eat something real. */
const TEST_PROJECTS = [
  "RFP response — Lakeway TX civil engineering (RFQ 26-1011)",
  "Board pack — week of 17 Aug 2026",
];
const TEST_USER_IDS = ["sam-uat-2026-08-17", "megan-uat-2026-08-17"];

const env = readEnv(INSTANCE);
const sql = postgres(env.DATABASE_URL, { max: 1 });
const B = (s) => `[1m${s}[0m`;
const Y = (s) => `[33m${s}[0m`;
const G = (s) => `[32m${s}[0m`;

console.log(B(`\n${APPLY ? "REMOVING" : "DRY RUN — nothing will be deleted"}\n`));

// --- what is here ---------------------------------------------------------
const projects = await sql`
  select p.id, p.name, (select count(*)::int from issues i where i.project_id = p.id) as issues
  from projects p where p.name = any(${TEST_PROJECTS})`;
const seeded = await sql`
  select id, key from company_context
  where value ilike '%SEED%' or value ilike '%synthetic%'`;
const users = await sql`
  select id, name, email from "user" where id = any(${TEST_USER_IDS})`;
const endpoints = await sql`
  select id, label from bridge_endpoints where user_id = any(${TEST_USER_IDS})`;

console.log("Projects (with their issues, comments and approvals):");
for (const p of projects) console.log(`  ${Y("delete")} ${p.name}  (${p.issues} issues)`);
console.log("\nSynthetic company-context rows:");
for (const c of seeded) console.log(`  ${Y("delete")} ${c.key}`);
console.log("\nStand-in people (they hold no credential and cannot sign in):");
for (const u of users) console.log(`  ${Y("delete")} ${u.name} <${u.email}>`);
console.log("\nTheir enrolled laptop endpoints:");
for (const e of endpoints) console.log(`  ${Y("delete")} ${e.label}`);

const [keep] = await sql`
  select (select count(*)::int from agents) as agents,
         (select count(*)::int from goals) as goals`;
console.log(`\n${G("Kept")}: ${keep.agents} agents, ${keep.goals} goal(s), the company, and Titus.`);

if (!APPLY) {
  console.log(B("\nRe-run with --apply to remove these.\n"));
  await sql.end();
  process.exit(0);
}

// --- backup first ---------------------------------------------------------
// Backups land in ~/.paperclip/backups/<instance>/, which is where
// `nightly-backup.mjs` writes them -- NOT in a directory this script invents.
// The first version printed "see ~/agentdash-backups", created that directory
// as a side effect of saying so, and left it empty. It looked exactly like a
// backup step that had silently done nothing. Verify by counting files before
// and after, so "backed up" is an observation rather than a claim.
const backupDir = join(homedir(), ".paperclip", "backups", INSTANCE);
console.log(B("\nBacking up before deleting"));
const countBackups = () => {
  try {
    return readdirSync(backupDir).filter((f) => f.endsWith(".sql.gz")).length;
  } catch {
    return 0;
  }
};
const backupsBefore = countBackups();
execFileSync("zsh", ["-lc", `AGENTDASH_INSTANCE=${INSTANCE} ~/agentdash/deploy/agentdash-backup.sh`], {
  stdio: "ignore",
});
const backupsAfter = countBackups();
if (backupsAfter > backupsBefore) {
  console.log(`  ${G("new backup written")} to ${backupDir}`);
} else {
  console.log(Y(`  NO new backup appeared in ${backupDir} — stopping rather than deleting unbacked data.`));
  await sql.end();
  process.exit(1);
}

// --- delete through the application ---------------------------------------
const cookie = await actAs(sql, env, "a27RVyyVTWwgMFcKrRDyOcfSMj9Ye0Vs"); // Titus, admin
console.log(B("\nDeleting projects through the API"));
for (const p of projects) {
  const res = await asPerson(BASE, cookie, "DELETE", `/api/projects/${p.id}?withIssues=true`);
  console.log(`  ${res.status < 300 ? G(String(res.status)) : Y(String(res.status))}  ${p.name}`);
  if (res.status >= 300) console.log(`        ${JSON.stringify(res.body).slice(0, 200)}`);
}

console.log(B("\nDeleting synthetic context rows"));
const ctx = await sql`
  delete from company_context
  where value ilike '%SEED%' or value ilike '%synthetic%' returning id`;
console.log(`  ${G(String(ctx.length))} removed`);

console.log(B("\nRemoving the stand-in people"));
for (const id of TEST_USER_IDS) {
  await sql`delete from bridge_tasks where endpoint_id in (select id from bridge_endpoints where user_id = ${id})`;
  await sql`delete from bridge_endpoints where user_id = ${id}`;
  await sql`delete from agent_stewardships where user_id = ${id}`;
  await sql`delete from company_memberships where principal_id = ${id}`;
  await sql`delete from session where user_id = ${id}`;
  await sql`delete from account where user_id = ${id}`;
  const gone = await sql`delete from "user" where id = ${id} returning email`;
  console.log(`  ${gone.length ? G("removed") : Y("absent")}  ${id}`);
}

// --- read the result back -------------------------------------------------
const [after] = await sql`
  select (select count(*)::int from projects) as projects,
         (select count(*)::int from issues) as issues,
         (select count(*)::int from "user") as users,
         (select count(*)::int from company_context) as context,
         (select count(*)::int from agents) as agents`;
console.log(B("\nAfter, read back from the database"));
console.log(`  projects ${after.projects}   issues ${after.issues}   users ${after.users}   context ${after.context}   agents ${after.agents}`);
await sql.end();
