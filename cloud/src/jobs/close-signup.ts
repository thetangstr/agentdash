// AgentDash (#767, SC-6): close a box's sign-up once its claim is seen (spec
// §3.5 step 4). Sets PAPERCLIP_AUTH_DISABLE_SIGN_UP=true, rotates the invite
// code to a value nobody records, blanks AGENTDASH_CLAIM_EMAIL, and erases the
// stored claim code. All with skipDeploys: a Volume redeploy would cut the
// founder off mid-onboarding, and the box already refuses the code (it has a
// user), so the variables simply ride the next deploy (§3.5 step 5).
// The email is blanked with an upsert, not variableDelete, because only the
// upsert takes skipDeploys.
import { and, eq, isNotNull } from "drizzle-orm";
import { boxEvents, boxes } from "../db/schema.js";
import { getProject, upsertVariables } from "../railway/api.js";
import type { RailwayClient } from "../railway/client.js";
import { newClaimCode } from "../railway/secrets.js";
import { FatalJobError } from "./errors.js";
import type { JobHandler } from "./runner.js";

export function closeSignupHandler(deps: { client: RailwayClient; workspaceId: string }): JobHandler {
  return {
    kind: "close_signup",
    maxDurationMs: 30 * 60_000,
    steps: [
      {
        name: "close_signup",
        timeoutMs: 60_000,
        async run(ctx) {
          const box = await ctx.box();
          if (!box.claimedAt) throw new FatalJobError(`box ${box.slug} has no recorded claim; refusing to close its sign-up`);
          if (!box.projectId || !box.environmentId || !box.webServiceId) {
            throw new FatalJobError(`box ${box.slug} has no recorded Railway service`);
          }
          const p = await getProject(deps.client, box.projectId, { signal: ctx.signal });
          if (p.workspaceId !== deps.workspaceId) throw new FatalJobError(`project ${p.id} is not in the boxes workspace`);
          await upsertVariables(
            deps.client,
            box.projectId,
            box.environmentId,
            box.webServiceId,
            { PAPERCLIP_AUTH_DISABLE_SIGN_UP: "true", AGENTDASH_INVITE_CODES: newClaimCode(), AGENTDASH_CLAIM_EMAIL: "" },
            { signal: ctx.signal },
          );
          await ctx.db
            .update(boxes)
            .set({ claimCodeEnc: null, claimCodeHash: null, updatedAt: new Date() })
            .where(and(eq(boxes.id, box.id), isNotNull(boxes.claimedAt)));
          await ctx.db.insert(boxEvents).values({ boxId: box.id, kind: "signup_closed", actor: "close-signup", detail: { takesEffect: "next deploy" } });
        },
      },
    ],
  };
}
