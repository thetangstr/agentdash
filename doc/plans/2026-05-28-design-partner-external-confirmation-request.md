# Design Partner External Confirmation Request

**Purpose:** Copy/paste request for the launch owner to collect the remaining external confirmations before moving PR #376 out of draft and asking the first MSP design partner to use the Mac mini instance.

**Current PR:** <https://github.com/thetangstr/agentdash/pull/376>
**Target URL under test:** `http://192.168.86.48:3100`
**Target Mac mini:** `maxiaoer@192.168.86.48`

Do not send passwords, session cookies, invite tokens, API keys, OAuth tokens, SSH keys, customer secrets, or raw customer data in the response. Send proof command output only after redacting any credentials or secrets.

## Copy/Paste Request

Please confirm the remaining launch gates for the AgentDash MSP Mac mini pilot.

Required before we move PR #376 out of draft:

1. Partner access path:
   - Confirm the chosen private access path: LAN, Tailscale, or other private network.
   - If Tailscale is used, confirm the Mac mini is reachable only by the intended tailnet users/devices and that ACL exposure is intentional.

2. Partner-device login proof:
   - Run the proof command from the actual partner device or chosen private-network device.
   - Use the proof account credentials out-of-band. Do not paste the password into chat, email, GitHub, or docs.
   - Send the redacted proof output or attach the generated proof transcript.

```sh
AGENTDASH_PROOF_EMAIL="<proof-account-email>" \
AGENTDASH_PROOF_PASSWORD="<proof-account-password>" \
scripts/msp-partner-access-proof.sh \
  --base-url http://192.168.86.48:3100 \
  --output "agentdash-partner-proof-$(date -u +%Y%m%dT%H%M%SZ).txt"
```

Required script result:

- `Status: Partner-device access proof passed.`
- `0 fail`

3. Browser proof:
   - Login succeeds from the same private URL.
   - The proof/operator account can see the expected company.
   - `/assess?onboarding=1` is reachable if the pilot still needs assessment onboarding.
   - `/cos` opens and can trigger one Hermes-backed CoS reply.

4. Operator and ownership confirmations:
   - Confirm `maxiaoer` is the intended Mac mini operator account.
   - Name the AgentDash launch owner.
   - Name the partner champion.
   - Name the MSP service manager or first operator.
   - Confirm the week-one issue channel.
   - Confirm the week-one daily check-in time.
   - Confirm the data classes approved for week-one use.

5. Security confirmation:
   - Confirm rotation of any GitHub token that may have appeared in the target Git remote before sanitization.
   - Confirm no public URL is being used unless explicitly approved by the launch owner.

## Response Template

```text
AgentDash MSP pilot external confirmation

Chosen access path:
Tailscale ACL/private-network notes:
Partner proof timestamp:
Partner proof transcript location or redacted output:
Proof account can see expected company: yes/no
Browser /assess?onboarding=1 reachable if required: yes/no/not required
Browser /cos Hermes-backed reply run id or transcript:
Operator account maxiaoer confirmed: yes/no
GitHub token rotation confirmed: yes/no
Launch owner:
Partner champion:
MSP service manager / first operator:
Week-one issue channel:
Week-one daily check-in time:
Week-one approved data classes:
No public URL used unless approved: yes/no
```

## Go/No-Go Interpretation

Launch is **go** only when every response-template field is filled with a concrete value and the proof command reports `0 fail`.

Launch is **no-go** if any of these are true:

- partner-device login proof fails
- partner access uses an unintended public URL
- proof account cannot see the expected company
- `/cos` cannot trigger a Hermes-backed reply from the partner-visible path
- GitHub token rotation is unconfirmed
- `maxiaoer` is not the intended operator account
- named owner/cadence/data-boundary fields are blank
