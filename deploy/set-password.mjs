/**
 * Set (or reset) a person's sign-in password, from this machine, offline.
 *
 * This exists because of a question with a bad answer: "how do we log in
 * tomorrow?" The instance runs in `authenticated` mode, so there is no
 * local-trusted bypass — somebody has to know a password. Exactly one account
 * on the real workspace has one, it was set on 2026-08-12, and if nobody
 * remembers it there is no way in at all. Password reset is no help either:
 * better-auth's reset flow mails a link, and nothing on this box is wired to
 * send auth email. Resend is configured for error alerts only.
 *
 * So this is the guaranteed door. It uses better-auth's OWN hasher
 * (`hashPassword` from `better-auth/crypto`), so the stored credential is
 * byte-for-byte what a normal sign-up would have written — not a lookalike
 * that happens to work until better-auth changes its scheme. It verifies the
 * result with `verifyPassword` before reporting success, because writing a
 * hash nobody can log in with is exactly the failure this is meant to prevent.
 *
 * Run it from `server/` so the dependency resolves:
 *
 *   cd ~/agentdash/server
 *   node ../deploy/set-password.mjs mkboard titus@mkthink.com
 *
 * Reads the password from a prompt, never from argv — an argument is visible
 * in `ps` and lands in shell history. Omit it and one is generated for you.
 */

import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";

// `better-auth` is a dependency of `server/`, not of the repo root, and Node
// resolves a bare import from the IMPORTING FILE's directory upward -- which
// for this file is `deploy/`, where it is not installed. Resolving explicitly
// against server's package means this works from any working directory
// instead of only from inside `server/`, which is the kind of detail that
// otherwise bites at the worst possible moment.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromServer = createRequire(join(repoRoot, "server", "package.json"));
const { hashPassword, verifyPassword } = await import(
  pathToFileURL(requireFromServer.resolve("better-auth/crypto")).href
);

const [instance, email] = process.argv.slice(2);
if (!instance || !email) {
  console.error("usage: node ../deploy/set-password.mjs <mkboard> <email>");
  process.exit(2);
}

const envText = readFileSync(join(homedir(), ".config", "agentdash", `${instance}.env`), "utf8");
const dbUrl = envText
  .split("\n")
  .filter((l) => l.startsWith("DATABASE_URL="))
  .pop()
  ?.slice("DATABASE_URL=".length)
  .replace(/^["']|["']$/g, "");
if (!dbUrl) {
  console.error(`No DATABASE_URL in ${instance}.env`);
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 1 });
const [user] = await sql`select id, name, email from "user" where lower(email) = lower(${email})`;
if (!user) {
  console.error(`No user with email ${email} on ${instance}.`);
  const all = await sql`select email from "user" order by email`;
  console.error(`Known: ${all.map((u) => u.email).join(", ") || "(none)"}`);
  await sql.end();
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const typed = (await rl.question(`New password for ${user.name} <${user.email}> (blank = generate): `)).trim();
rl.close();
// Four words of hex is long enough to be safe and short enough to read aloud
// across a server room, which is the situation this is for.
const password = typed || Array.from({ length: 4 }, () => randomBytes(3).toString("hex")).join("-");

const hash = await hashPassword(password);

// better-auth keys a password credential on providerId 'credential'. An OAuth
// row for the same user is a different provider and must not be touched.
const [existing] = await sql`
  select id from account where user_id = ${user.id} and provider_id = 'credential'`;

if (existing) {
  await sql`update account set password = ${hash}, updated_at = now() where id = ${existing.id}`;
  console.log("Updated the existing credential.");
} else {
  await sql`
    insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
    values (${randomBytes(16).toString("hex")}, ${user.id}, 'credential', ${user.id}, ${hash}, now(), now())`;
  console.log("Created a credential (this account had none — they could not sign in before).");
}

// Prove it, rather than assume the write landed in a usable form.
const [check] = await sql`
  select password from account where user_id = ${user.id} and provider_id = 'credential'`;
const ok = await verifyPassword({ hash: check.password, password });
await sql.end();

if (!ok) {
  console.error("\nFAILED: the stored hash does not verify. Do not rely on this account.");
  process.exit(1);
}

console.log("\nVerified against better-auth's own checker.");
console.log(`\n  instance : ${instance}`);
console.log(`  email    : ${user.email}`);
if (!typed) console.log(`  password : ${password}`);
console.log("\nSign in at https://mkmini.local:3112");
