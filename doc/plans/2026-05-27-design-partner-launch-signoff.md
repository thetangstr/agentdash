# Design Partner Launch Signoff

**Purpose:** One-page go/no-go packet for moving PR #376 from draft to the first MSP design-partner launch.

**Current PR:** <https://github.com/thetangstr/agentdash/pull/376>
**Current launch head:** use the latest PR #376 head and CI status line.
**Target Mac mini:** `maxiaoer@192.168.86.48`
**Private URL under test:** `http://192.168.86.48:3100`
**External confirmation request:** `doc/plans/2026-05-28-design-partner-external-confirmation-request.md`

Do not paste passwords, session cookies, invite tokens, API keys, OAuth tokens, SSH keys, or raw customer secrets into this document.

## Current Evidence

| Area | Evidence | Status |
| --- | --- | --- |
| PR branch | `codex/msp-mac-mini-launch` pushed to origin | Complete |
| PR checks | `check`, `audit`, `drift`, `policy`, `verify`, `e2e`, Vercel, Vercel Preview Comments pass on the latest PR #376 head | Complete |
| Target checkout | `/Users/maxiaoer/workspace/agentdash_msp_launch` clean at the latest PR #376 head | Complete |
| Local health | `curl -fsS http://127.0.0.1:3100/api/health` returns authenticated/ready JSON | Complete |
| Host readiness | `scripts/msp-mac-mini-readiness.sh --run-backup --run-instance-backup --base-url http://192.168.86.48:3100` returned `30 pass, 12 warn, 0 fail` | Complete |
| Network precheck | `scripts/msp-partner-access-proof.sh --network-only --base-url http://192.168.86.48:3100` returned `9 pass, 1 warn, 0 fail` | Precheck only |
| Unauthenticated access | Network precheck confirmed `/api/auth/get-session` rejects with HTTP `401` and `/api/companies` rejects with HTTP `403` | Complete |
| Hermes CoS | CoS reply routed through `hermes_local` and `/Users/maxiaoer/.local/bin/hermes` | Complete |
| Hermes agent run | Assigned issue-write run completed and wrote `Hermes issue-write smoke completed` | Complete |
| Database backup | `/Users/maxiaoer/.agentdash/instances/default/data/backups/paperclip-20260527-171657.sql.gz` | Complete |
| Instance-file backup | `/Users/maxiaoer/.agentdash/instances/default/data/backups/agentdash-instance-files-20260528T001657Z.tgz` | Complete |
| Git remote hygiene | Readiness reports target Git remotes do not contain embedded credentials | Complete |
| Billing posture | Stripe disabled for managed week-one design-partner pilot | Complete |
| Email posture | Resend disabled; manual invites/password resets for week one | Complete |
| External confirmation request | `doc/plans/2026-05-28-design-partner-external-confirmation-request.md` is ready to send | Complete |

## Go/No-Go Checklist

Move PR #376 out of draft only after every item below is filled.

- [ ] Partner login proof passes from the actual partner device or tailnet/LAN device.
- [ ] Chosen access path is confirmed: LAN / Tailscale / other private network.
- [ ] If Tailscale is chosen, Tailscale install and ACL exposure are confirmed.
- [ ] Proof account can see the expected company after login.
- [ ] Browser proof confirms `/assess?onboarding=1` is reachable if the pilot still requires assessment onboarding.
- [ ] Browser proof confirms `/cos` opens and can trigger one Hermes-backed CoS reply.
- [ ] GitHub token rotation is confirmed for any token that may have been stored in the target Git remote before sanitization.
- [ ] `maxiaoer` is confirmed as the intended Mac mini operator account.
- [ ] Launch owner is named.
- [ ] Partner champion is named.
- [ ] MSP service manager or first operator is named.
- [ ] Week-one issue channel is confirmed.
- [ ] Week-one daily check-in time is confirmed.

## Partner Proof Command

Run from the actual partner machine or chosen private-network device:

```sh
AGENTDASH_PROOF_EMAIL="<proof-account-email>" \
AGENTDASH_PROOF_PASSWORD="<proof-account-password>" \
scripts/msp-partner-access-proof.sh \
  --base-url http://192.168.86.48:3100 \
  --output "agentdash-partner-proof-$(date -u +%Y%m%dT%H%M%SZ).txt"
```

Required result:

- `Status: Partner-device access proof passed.`
- `0 fail`

Do not include the proof password when pasting the output into a launch ticket or PR comment.

For the full copy/paste request, use `doc/plans/2026-05-28-design-partner-external-confirmation-request.md`.

## Signoff Fields

| Field | Value |
| --- | --- |
| Partner device/user | |
| Chosen access path | |
| Partner proof timestamp | |
| Partner proof output location or redacted transcript | |
| Operator account confirmed | |
| GitHub token rotation confirmed | |
| Launch owner | |
| Partner champion | |
| MSP service manager / first operator | |
| Week-one issue channel | |
| Week-one daily check-in time | |
| Data classes approved for week one | |

## Day-One Script

1. Confirm the partner can log in from the chosen private URL.
2. Run Ticket Concierge with 5-20 sanitized tickets or alert summaries.
3. Capture accepted, edited, and rejected recommendations.
4. Create follow-up AgentDash tasks for accepted actions only.
5. Trigger one Hermes-backed CoS reply and capture the transcript link or run id.
6. End with a 15-minute retro: value, friction, data-boundary concerns, and next-day workflow.

## No-Go Conditions

Do not launch if any of these are true:

- partner-device login proof fails
- partner access uses an unintended public URL
- bootstrap invite is active
- unauthenticated board API access succeeds
- target logs expose secret-like material
- target Git remotes contain embedded credentials
- backup evidence is missing
- Hermes CoS or assigned-agent proof is missing
- named owner/cadence fields are blank
