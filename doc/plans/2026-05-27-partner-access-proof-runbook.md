# Partner Access Proof Runbook

**Purpose:** Capture the final P0 evidence that the first MSP design partner can reach and log in to the Mac mini AgentDash instance from the chosen private network path.

**Current target URL:** `http://192.168.86.48:3100`

Do not paste passwords, session cookies, or invite tokens into this document. The proof script redacts by omission: it records the proof account email but never prints the password.

## Network-Only Precheck

Use this when validating the URL from any LAN/tailnet device before sharing proof-account credentials:

```sh
scripts/msp-partner-access-proof.sh \
  --network-only \
  --base-url http://192.168.86.48:3100
```

Evidence captured from the operator LAN device on 2026-05-27:

- `9 pass, 1 warn, 0 fail`
- `/api/health` reachable
- deployment mode is `authenticated`
- bootstrap status is `ready`
- no active bootstrap invite
- UI shell loads
- unauthenticated `/api/auth/get-session` rejects with HTTP `401`
- unauthenticated `/api/companies` rejects with HTTP `403`

This does **not** satisfy the partner-device login proof gate because it intentionally skips sign-in.

## Partner Login Proof

Run this from the actual partner machine or tailnet/LAN device that will operate the pilot:

```sh
AGENTDASH_PROOF_EMAIL="<proof-account-email>" \
AGENTDASH_PROOF_PASSWORD="<proof-account-password>" \
AGENTDASH_EXPECTED_COMPANY="<expected-company-name-or-id>" \
scripts/msp-partner-access-proof.sh \
  --base-url http://192.168.86.48:3100 \
  --output "agentdash-partner-proof-$(date -u +%Y%m%dT%H%M%SZ).txt"
```

Required pass conditions:

- partner-visible base URL is non-loopback
- health endpoint is reachable
- health reports authenticated deployment mode
- health reports bootstrap ready
- health reports no active bootstrap invite
- UI shell loads
- unauthenticated session check rejects
- unauthenticated board API rejects
- proof-account sign-in succeeds
- authenticated session is visible
- authenticated `/api/companies` returns a JSON array
- expected company name or id is visible in the authenticated `/api/companies` response

After saving the redacted proof output and the filled external confirmation response, run:

```sh
scripts/msp-launch-signoff-check.sh \
  --response <filled-external-confirmation-response.txt> \
  --proof-output <redacted-partner-proof-output.txt>
```

This must report `Status: Launch external signoff check passed.` before PR #376 leaves draft.

## Manual Browser Proof

After the script passes, capture these human checks in the launch ticket or partner signoff note:

- Browser opens the same private URL from the partner machine.
- Login works with the intended operator account.
- The operator can see the expected company.
- `/assess?onboarding=1` is reachable if the pilot script still requires the onboarding assessment.
- `/cos` opens and the operator can trigger one Hermes-backed CoS reply.
- No public internet URL is being used unless the launch owner explicitly approved public exposure.

## Signoff Fields

Fill these before moving PR #376 out of draft:

- Partner device/user:
- Chosen access path: LAN / Tailscale / other private network
- Proof command timestamp:
- Proof output file or pasted redacted transcript:
- Expected company name or id used for proof:
- Operator account confirmed:
- GitHub token rotation confirmed:
- Launch owner:
- Partner champion:
- Week-one issue channel:
- Week-one daily check-in time:
