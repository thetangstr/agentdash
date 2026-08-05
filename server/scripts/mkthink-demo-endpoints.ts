#!/usr/bin/env tsx
/**
 * Seed bridge endpoints for the MKThink board-deck demo.
 *
 * Why this exists as a script instead of HTTP: `POST /companies/:id/me/bridge/endpoints`
 * binds the endpoint to the CALLING board user, and in `local_trusted` every request is
 * the same synthetic user (`local-board`, middleware/auth.ts). The demo needs three
 * DISTINCT humans, because `agentFactRequestService.escalate` resolves the answering
 * agent's steward and then looks up bridge endpoints *for that steward's userId* — an
 * endpoint owned by anyone else is invisible to it, and the fact falls to the
 * unreachable-harness stall path instead of reaching a person.
 *
 * So this calls the real bridgeService (same code the route calls: requestEnrollment
 * then approveEnrollment) with an explicit userId, and prints the endpoint tokens the
 * "human's machine" then uses to poll and answer.
 *
 * Usage:  DEMO_COMPANY_ID=<uuid> npx tsx scripts/seed/mkthink-demo-endpoints.ts <userId>...
 */
import { companyMemberships, createDb } from "@paperclipai/db";
import { bridgeService } from "../src/services/bridge.js";

const url =
  process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const companyId = process.env.DEMO_COMPANY_ID;
const userIds = process.argv.slice(2);

if (!companyId) {
  console.error("DEMO_COMPANY_ID is required");
  process.exit(1);
}
if (userIds.length === 0) {
  console.error("pass at least one userId");
  process.exit(1);
}

const db = createDb(url);
const bridge = bridgeService(db as never);
const out: Array<{ userId: string; endpointId: string; token: string }> = [];

for (const userId of userIds) {
  // Stewardship refuses a non-member: agent-stewardships.ts:52 requires an ACTIVE
  // company_memberships row with principalType='user'. There is no HTTP route to add
  // a member directly (production goes through the invite flow), so the demo seeds it.
  await db
    .insert(companyMemberships)
    .values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" })
    .onConflictDoNothing();

  const { enrollmentId } = await bridge.requestEnrollment(companyId, {
    userId,
    label: `${userId} laptop`,
    // bridge:read is what escalate() requires to consider a harness reachable;
    // bridge:act lets the same machine take gated action tasks.
    capabilities: ["bridge:read", "bridge:act"],
  });
  // Self-approval is deliberate here and in the route: the human enrolling their own
  // machine IS the human whose approval matters (see routes/bridge.ts).
  const { endpointId, token } = await bridge.approveEnrollment(companyId, enrollmentId, userId);
  out.push({ userId, endpointId, token });
}

console.log(JSON.stringify(out, null, 2));
process.exit(0);
