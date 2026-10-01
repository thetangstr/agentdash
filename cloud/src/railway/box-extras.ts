// AgentDash (SC-8, GH #769): the Stripe and Resend part of a box's variables
// (spec §3.3 step 5, §3.7), plugged into the provisioner's variables step.
// prepare() returns the variables to add to the step's single upsert;
// commit() records what the box now holds, only after Railway accepted it.
//
// Either half is skipped (with a warning and a box event) while the control
// plane lacks its configuration; the fleet sync and a later re-provision
// fill it in. Nothing here logs a value.
import { eq } from "drizzle-orm";
import type { DataKeyring } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes, type BoxPurpose } from "../db/schema.js";
import { provisionBoxResendKey, type ResendKeysClient } from "../email/resend-keys.js";
import type { BoxRow } from "../jobs/runner.js";
import type { Logger } from "../logger.js";
import { currentFleetBilling, ensureBoxWebhookSecret, stripeVariables } from "../stripe/box-billing.js";
import type { BillingConfig } from "../stripe/config.js";
import type { FleetSecretStore } from "../stripe/fleet-secrets.js";

export interface BoxExtrasInput {
  db: CloudDb;
  box: BoxRow;
  /** Names of the variables the web service already has. */
  names: Set<string>;
  log: Logger;
  signal: AbortSignal;
}

export interface BoxExtras {
  prepare(input: BoxExtrasInput): Promise<{ vars: Record<string, string>; commit(): Promise<void> }>;
}

// AgentDash (GH #861 + SC-8): purposes that never bill. A `demo` or
// `internal` box is ours, not a customer's: it gets AGENTDASH_BILLING_DISABLED
// instead of Stripe config, and the fleet sync leaves it alone
// (BILLING_SYNC_PURPOSES in ../stripe/box-billing.ts). `canary` keeps billing
// so the first wave exercises the real upgrade path.
const NON_BILLING_PURPOSES = new Set<BoxPurpose>(["demo", "internal"]);

export function billingAndMailExtras(deps: {
  keys: DataKeyring;
  billing: BillingConfig;
  store: FleetSecretStore;
  /** Null when CLOUD_RESEND_ADMIN_API_KEY is not set. */
  resend: ResendKeysClient | null;
}): BoxExtras {
  return {
    async prepare({ db, box, names, log, signal }) {
      const vars: Record<string, string> = {};
      const sentAt = new Date();
      const skipped: string[] = [];
      const noBilling = NON_BILLING_PURPOSES.has(box.purpose);
      const { billing: fleet, missing } = await currentFleetBilling(deps.store, deps.billing);
      if (noBilling) {
        vars.AGENTDASH_BILLING_DISABLED = "true";
        skipped.push("billing");
      } else if (fleet) {
        Object.assign(vars, stripeVariables(fleet, await ensureBoxWebhookSecret(db, deps.keys, box)));
      } else {
        skipped.push("stripe");
        log.warn("box provisioned without Stripe: the fleet billing config is incomplete", { slug: box.slug, missing });
      }
      // A box keeps the Resend key it has; one is made only when it has none.
      if (!names.has("RESEND_API_KEY")) {
        if (deps.resend && deps.billing.resendBoxDomainId) {
          vars.RESEND_API_KEY = await provisionBoxResendKey(db, deps.resend, box, deps.billing.resendBoxDomainId, signal);
          vars.AGENTDASH_EMAIL_FROM = deps.billing.boxEmailFrom;
        } else {
          skipped.push("resend");
          log.warn("box provisioned without email: CLOUD_RESEND_ADMIN_API_KEY is not set", { slug: box.slug });
        }
      }
      return {
        vars,
        async commit() {
          // Pending until the box's next successful deploy (the provision's own deploy step), see promoteDeployedBillingRevs.
          if (fleet && !noBilling) {
            await db.update(boxes).set({ stripeConfigPendingRev: fleet.rev, stripeConfigPendingSince: sentAt, updatedAt: new Date() }).where(eq(boxes.id, box.id));
          }
          if (skipped.length) {
            await db.insert(boxEvents).values({ boxId: box.id, kind: "billing_mail_skipped", actor: "provisioner", detail: { skipped, missing } });
          }
        },
      };
    },
  };
}
