/**
 * "It is on the network — now what?"
 *
 * Prints the URLs to open and, more usefully, the things that are NOT ready.
 * Written because the honest answer to "is it all set up?" on 2026-08-17 was
 * "the software is, the people are not" -- two of the three humans in the
 * database had no credential of any kind and could not have signed in, which
 * is not visible from any screen until someone tries.
 *
 * Read-only. Safe to run any time, on either instance.
 *
 * Usage: node deploy/readiness.mjs [lanIp] [tsName]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const [lanIp, tsName] = process.argv.slice(2);
const G = (s) => `[32m${s}[0m`;
const R = (s) => `[31m${s}[0m`;
const Y = (s) => `[33m${s}[0m`;
const B = (s) => `[1m${s}[0m`;

function envOf(instance) {
  const text = readFileSync(join(homedir(), ".config", "agentdash", `${instance}.env`), "utf8");
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const blockers = [];
const notes = [];

for (const [instance, tlsPort] of [["mkboard", 3112]]) {
  const env = envOf(instance);
  const sql = postgres(env.DATABASE_URL, { max: 1 });
  console.log(`\n${B(`── ${instance} ─────────────────────────────────────────────`)}`);

  console.log("\n  Open one of these:");
  for (const host of ["mkmini.local", tsName, lanIp].filter(Boolean)) {
    console.log(`    https://${host}:${tlsPort}`);
  }

  // --- who can actually sign in -------------------------------------------
  const users = await sql`
    select u.id, u.name, u.email,
           (select count(*)::int from account a
             where a.user_id = u.id and a.password is not null) as can_sign_in,
           m.membership_role
    from "user" u
    left join company_memberships m on m.principal_id = u.id
    order by u.name`;

  console.log("\n  People:");
  for (const u of users) {
    const ok = u.can_sign_in > 0;
    console.log(
      `    ${ok ? G("can sign in ") : R("NO LOGIN   ")} ${(u.membership_role ?? "-").padEnd(6)} ${u.name} <${u.email}>`,
    );
    if (!ok) {
      blockers.push(`${instance}: ${u.name} <${u.email}> has no password — they cannot sign in.`);
    }
  }

  const [invites] = await sql`
    select count(*)::int as open from invites
    where accepted_at is null and revoked_at is null and expires_at > now()`;
  if (invites.open > 0) {
    // `invites` stores `token_hash`, never the token. An outstanding invite
    // whose link nobody kept is unusable and cannot be recovered from here --
    // it has to be reissued. Counting them as progress would be misleading.
    console.log(`    ${Y(`${invites.open} open invite(s)`)} — links are NOT recoverable (only a hash is stored)`);
    notes.push(
      `${instance}: ${invites.open} invite(s) are open but their links cannot be recovered. ` +
      `If you do not still have the URL, revoke and reissue rather than waiting on them.`,
    );
  } else {
    console.log("    no open invites");
  }

  // --- the workforce -------------------------------------------------------
  const agents = await sql`select name, status from agents order by name`;
  const [keyed] = await sql`
    select count(distinct agent_id)::int as n from agent_api_keys where revoked_at is null`;
  console.log(`\n  Agents: ${agents.length} (${agents.map((a) => a.name).join(", ")})`);
  console.log(`    ${keyed.n} of ${agents.length} have an API key a harness could connect with`);

  const [endpoints] = await sql`
    select count(*)::int as n from bridge_endpoints where enrolled_at is not null and revoked_at is null`;
  console.log(`    ${endpoints.n} laptop bridge endpoint(s) enrolled`);

  // --- what is already in the workspace ------------------------------------
  const [counts] = await sql`
    select (select count(*)::int from projects) as projects,
           (select count(*)::int from issues)   as issues,
           (select count(*)::int from goals)    as goals`;
  const [seeded] = await sql`
    select count(*)::int as n from company_context
    where value ilike '%SEED%' or value ilike '%synthetic%'`;
  console.log(`\n  Content: ${counts.projects} projects, ${counts.issues} issues, ${counts.goals} goal(s)`);
  if (seeded.n > 0) {
    console.log(`    ${Y(`${seeded.n} company-context row(s) are SEED/synthetic test data`)}`);
    notes.push(
      `${instance}: ${seeded.n} synthetic company-context row(s) are still present. They are labelled, ` +
      `but decide whether the client should see them before showing anyone the workspace.`,
    );
  }

  // --- spend ---------------------------------------------------------------
  const [cost] = await sql`select count(*)::int as n from cost_events`;
  if (cost.n === 0) {
    console.log(`    ${Y("cost_events is empty — spend is NOT being measured (M1 open)")}`);
    notes.push(`${instance}: token metering is not wired, so every cost figure reads as unmeasured, not as zero.`);
  }

  // The sink stores one row per FINGERPRINT with a count, not one row per
  // occurrence, so `count(*)` would understate a repeating failure badly.
  const [errs] = await sql`
    select coalesce(count(*), 0)::int as kinds, coalesce(sum(count), 0)::int as total
    from server_errors where last_seen > now() - interval '24 hours'`;
  console.log(
    `    ${errs.kinds === 0 ? G("0") : Y(String(errs.total))} server error(s) in the last 24h` +
    `${errs.kinds > 0 ? ` across ${errs.kinds} distinct fault(s)` : ""}`,
  );
  if (errs.kinds > 0) {
    notes.push(`${instance}: ${errs.total} error(s) logged in 24h — read them at Company → Settings → Errors.`);
  }

  await sql.end();
}

console.log(`\n${B("── Before you tell anyone it is ready ──────────────────")}`);
if (blockers.length === 0) {
  console.log(`  ${G("No blockers.")}`);
} else {
  for (const b of blockers) console.log(`  ${R("BLOCKER")}  ${b}`);
  console.log(`\n  Fix: sign in as an admin, invite them (Settings → People), and send the link.`);
  console.log(`  Invites are LINK-based — nothing is emailed automatically. You hand over the URL.`);
}
for (const n of notes) console.log(`  ${Y("note")}     ${n}`);
console.log("");
