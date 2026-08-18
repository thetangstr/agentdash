/**
 * Mint a password-set link for someone, and print it instead of mailing it.
 *
 * The problem this solves: you need to get the customer's admin into their own
 * workspace, you do not know their password, and nobody should. `POST
 * /api/auth/request-password-reset` handles that — but it mails the link to the
 * account holder, which is wrong when you want to hand it over in person rather
 * than have it land cold in their inbox a week before you arrive.
 *
 * So this uses the same door the MCP-native signup flow uses:
 * `capturePasswordResetUrl` registers a resolver, and `sendResetPassword` sees a
 * waiting resolver and returns BEFORE calling sendEmail. The token is real and
 * written to `verification` by better-auth itself — no hand-rolled credential —
 * and no message is sent to anyone.
 *
 * The link survives being generated early, on both axes that matter:
 *   - the host is whatever PAPERCLIP_PUBLIC_URL says, which on this box is the
 *     tailnet name over TLS. It was `mkmini.local:3102` until 2026-08-17, and
 *     that was wrong on two counts at once: mDNS is link-local, so the name
 *     does not resolve over Tailscale at all, and :3102 is the PLAINTEXT port,
 *     so every minted link quietly bypassed the TLS front door. Both failures
 *     are invisible on the LAN, where the link works fine — which is why they
 *     survived. The tailnet name now carries a publicly-trusted certificate,
 *     so it resolves and validates from anywhere the person is on the tailnet.
 *   - the lifetime is AGENTDASH_RESET_TOKEN_TTL_SECONDS (7 days on the design
 *     partner's box), not better-auth's 1 hour default.
 *
 * The env file selects the workspace, because DATABASE_URL is what decides
 * whether you just minted a token against the real board or the practice one:
 *
 *   cd ~/agentdash/server
 *   set -a && . ~/.config/agentdash/mkboard.env && set +a
 *   pnpm exec tsx scripts/mint-reset-link.ts titus@mkthink.com
 *
 * Prints the URL plus the expiry read back from the database, because the expiry
 * that matters is the row's, not the one the email copy claims.
 */

import { createDb, authUsers, authVerifications } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.js";
import {
  createBetterAuthInstance,
  capturePasswordResetUrl,
} from "../src/auth/better-auth.js";

const email = process.argv[2]?.trim();
if (!email || !email.includes("@")) {
  console.error("usage: pnpm exec tsx scripts/mint-reset-link.ts <email>");
  console.error("  source the instance env file first — DATABASE_URL selects the workspace");
  process.exit(64); // EX_USAGE
}

const config = loadConfig();
const workspace = config.databaseUrl.split("/").pop() ?? "unknown";
const db = createDb(config.databaseUrl);

// Fail before minting if there is no such account. Otherwise better-auth's
// deliberate "don't confirm whether the address exists" behaviour reaches us as
// a silent 15-second timeout, which reads like a broken script.
const existing = await db
  .select({ id: authUsers.id })
  .from(authUsers)
  .where(eq(authUsers.email, email))
  .limit(1);
if (existing.length === 0) {
  console.error(`no account for ${email} in workspace '${workspace}'`);
  process.exit(1);
}

// trustedOrigins is irrelevant here: we mint a token, we never serve a request.
const auth = createBetterAuthInstance(db as any, config, []);

const url = await capturePasswordResetUrl(auth, email, 15_000);
if (!url) {
  console.error(
    `failed to mint a link for ${email} — better-auth did not invoke ` +
      "sendResetPassword within 15s",
  );
  process.exit(1);
}

const token = url.split("token=")[1] ?? "";
const rows = await db
  .select({ expiresAt: authVerifications.expiresAt })
  .from(authVerifications)
  .where(eq(authVerifications.identifier, `reset-password:${token}`))
  .limit(1);

console.log("");
console.log(`  link      ${url}`);
console.log(`  for       ${email}  (workspace '${workspace}')`);
console.log(
  rows.length > 0
    ? `  expires   ${rows[0].expiresAt.toISOString()}`
    : "  expires   could not read it back — check the verification table by hand",
);
console.log("");
console.log("  No email was sent. Hand this over yourself.");
console.log("");
process.exit(0);
