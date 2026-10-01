# Hosted box support

How a design partner on a hosted box (`<slug>.agentdash.cloud`) gets help, and what the operator does with a request. Companion to [hosted-box.md](hosted-box.md) and [cloud-control-plane.md](cloud-control-plane.md).

## For the design partner

Email **support@agentdash.cloud** with your box address, what you were doing, what you expected, and what happened. Screenshots help.

> TODO (founder): confirm the support@agentdash.cloud mailbox exists and who reads it before this address is published anywhere. Until then it is unconfirmed.

Support never signs in as you. If we need to look inside your workspace, we ask first and use a separate, named account you add (D-S7). We are never the sole instance admin of your box.

## What the operator checks first

In order, noting each result on the support thread. `$A` is the control-plane admin CLI (`A="pnpm --filter @agentdash/cloud-control admin"`, see cloud-control-plane.md).

1. `$A boxes list`: find the box by slug. Check its status, `plan_tier`, whether upgrades are held and its release tag.
2. Box health: `curl -s https://<slug>.agentdash.cloud/api/health | jq '{status,deploymentMode,bootstrapStatus,releaseTag}'`. Expect `status` ok and `deploymentMode` authenticated. No answer: check the Railway project `agentdash-box-<slug>` (web service deployments and logs).
3. Box events: read the box's `box_events` rows for the slug (provision, upgrade, cleanup, billing trail) in the control-plane database. There is no `admin box events` command yet, so this is a SQL read; TODO: add one.

Common fixes: resume a stopped service with `provision-box.sh --slug <slug> --release <tag> --redeploy` (hosted-box.md section 11); roll back a bad update as in hosted-box.md section 10.

## Escalation

1. Box unhealthy or data at risk: take a backup first (hosted-box.md section 9), then restore or redeploy. Never delete anything.
2. Not resolved within one working day, or any suspected data exposure: escalate to the founder with the box slug, the health output and the box events.
3. Billing questions: check the box's `plan_tier`; escalate to the founder before changing a subscription.
4. Track it in a GitHub issue and tell the partner the status and when the next update comes.
