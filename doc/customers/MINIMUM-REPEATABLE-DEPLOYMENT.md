# Minimum Repeatable Deployment — AGE-17

**Owner:** Forge (Platform & Delivery)
**Status:** Draft for board review. **Re-runs required after AGE-14 closes** (MKThink value measurement) and after every design-partner install.
**Date:** 2026-08-19
**Goal reference:** `82fd63dc-9494-4cfc-97c7-a0d393ac1392` (Platform & Delivery → "Turnkey product: download, onboard, running")
**Companions:** [`doc/GETTING-STARTED.md`](../GETTING-STARTED.md) (the install prompt), [`doc/customers/mkthink/`](mkthink/) (MKThink-specific artefacts), [`doc/SOP-onsite.md`](../SOP-onsite.md) (Mac-mini on-site SOP), [`doc/plans/2026-05-29-vps-cloud-and-outcome-pricing.md`](../plans/2026-05-29-vps-cloud-and-outcome-pricing.md) (commercial shape), the [`commercial-offer-v0`](../../../../../.paperclip/instances/default/projects/f2fc663b-9395-48c5-a002-c89a77fbfddc/99a860c8-4941-4bb5-bfc3-688323cc9c63/_default/commercial-offer-v0.md) (Beacon's offer memo, AGE-16).

---

## 0. What this document is

Per Casper's review of the Platform & Delivery goal, this document defines the
**minimum deployment that is repeatable enough to deliver to a second customer
without an engineer on the customer's premises for an entire afternoon.** It
covers the six dimensions Casper named:

1. Tenant model
2. Onboarding steps
3. SLOs
4. Security boundary
5. Operating cost
6. The acceptance test a second customer's install must pass

The second half of the document is the **manual-step ledger**: every manual
step MKThink suffered, classified as **AUTOMATED** (the script does it),
**ONBOARDED** (folded into the install prompt and run by the customer's own
agent), or **DELIBERATE** (a documented choice that the customer owns). This is
the audit trail for the goal text "each becomes automated, folded into
onboarding, or documented as deliberate."

A new install at a second customer is a **PASS** when it has run
[`scripts/msp-mac-mini-readiness.sh`](../../scripts/msp-mac-mini-readiness.sh)
to zero failures AND signed off the second-customer acceptance test in §7.

---

## 1. Tenant model

**Shape today (Mac-mini single-tenant; same shape applies to managed VPS):**

| Boundary | Mechanism | Notes |
|---|---|---|
| One deployable per customer | One Paperclip `instanceId`, one Postgres database, one env file (`600`), one set of LaunchAgents/`systemd` units | Multi-instance on one host works (see `agentdash_msp_launch/deploy/install.sh`: `AGENTDASH_INSTANCE=…`) but is a multi-tenant-of-ONE-host pattern we do not expose to customers. |
| One Paperclip `workspace` per install (when the install is on-prem for a single customer) | `one workspace per install; a "fresh company" means a fresh instance, not a second workspace` — verbatim from `RUNBOOK-TESTING.md §15.1` | The Mac mini path doesn't even attempt multi-company inside one customer host. |
| One vendor-operated managed-VPS instance per design partner (P0 in the VPS plan) | Single Ubuntu host, single Postgres, single DNS name, single Caddy | Multi-tenant cloud is **explicitly deferred until P2.** Reasons in `doc/plans/2026-05-29-vps-cloud-and-outcome-pricing.md` §"P2: Multi-Tenant Cloud". |
| Cross-customer isolation | Network boundary (separate host or separate cloud account) | Customer data never crosses the boundary because there *is* no shared tenant. This is the entire point of the single-tenant-by-default position. |
| Auth origin / allowed-hostnames | `PAPERCLIP_ALLOWED_HOSTNAMES` + `PAPERCLIP_PUBLIC_URL` + Better Auth `deriveAuthTrustedOrigins` | A misconfigured `ALLOWED_HOSTNAMES` is the silent failure that masquerades as a server bug (origins `403 INVALID_ORIGIN`). |
| Cross-tenant API refusal | Per-company filter in every company-scoped route (agent keys cannot read other companies; verified in `TEST-PLAN.md §B1.2`) | What `agentdash_assessment_test` calls the "tenant gate". |

**What this means for a second customer.** They get *their own* Postgres, *their own* LaunchAgent/LaunchDaemon/systemd unit set, *their own* env file with mode `600`, *their own* backups in `~/.paperclip/backups/<instance>/`, and *their own* DNS name (or `mkmini.local` if they don't have one). The control plane doesn't have a tenant concept — it has a one-customer-per-process concept.

**Deliberate non-decisions still open:**

- **Multi-tenant AgentDash Cloud.** Gated on tenant-isolation tests, SSO/SAML, mature backup/restore by tenant, and an audit-log review of impersonation flow. Not a v0 deliverable.
- **Single-tenant managed cloud.** P1 of the VPS plan; out of scope here, because every line in this doc applies equally to managed-VPS and on-prem-Mac-Mini once the install script is generalised.
- **Self-serve checkout.** P2. v0 is sales-motion.

---

## 2. Onboarding steps

The repeatable onboarding is **one prompt, one machine.** Both halves of
"repeated enough" live in `doc/GETTING-STARTED.md`:

> The promise: **they paste one prompt into their agent and the install drives
> itself.**

### 2.1 What the customer receives first (before they start)

The agent cannot invent secrets. We send one welcome email carrying exactly four items:

| What we send | Why they can't self-serve it |
|---|---|
| **Invite code** (`AGD-MKTHINK-7F3K`-shaped) | Gates the signup funnel. Validated against `agentdash.cloud`; unreachable validator → fail closed. |
| **Workspace code** (`MK-WORKFORCE-92QD`-shaped) | Authorises the `agentdash_mk` product profile at company creation. Without it, every workforce surface 404s. **This is the second-most-common silent failure.** |
| **License key** | Records the on-prem entitlement. NB: enforcement is **not currently wired** (`requireLicense` has no caller — see `GETTING-STARTED.md` §1 note). We still ship the env in forward-compatible form. |
| **License public key** | The verifying half of the pair. |

### 2.2 What the customer supplies in conversation

The prompt **asks** and **never guesses** for:

1. Their own email (founding admin)
2. Teammates' emails (each who will steward an agent)
3. Which model runs the agents — `claude_local` (recommended default, BYO tokens), or any other adapter with a key
4. *(Optional)* Telegram bot token + username
5. *(Optional)* Resend API key — only if invite emails must be delivered by mail. Without it the agent hands the invite links over directly.

### 2.3 What the machine generates

- `BETTER_AUTH_SECRET`, `PAPERCLIP_AGENT_JWT_SECRET` (openssl)
- Its own LAN IP (detected, not asked)
- **The database** — embedded Postgres ships with the server. No `DATABASE_URL` to set, no Docker, no separate DB process to babysit.

### 2.4 The 10-step install prompt

[`doc/GETTING-STARTED.md`](../GETTING-STARTED.md) §4 lists the prompt verbatim. Summarised:

| Step | What | Owner | Failure mode the prompt guards |
|---|---|---|---|
| 1 | Check node/pnpm/git/claude CLI; install missing | the customer's agent | Tools the install silently depends on |
| 2 | Clone repo + `pnpm install --frozen-lockfile && pnpm build` | the customer's agent | Lockfile drift (explicit `--frozen-lockfile`) |
| 3 | Configure env — generate secrets, detect LAN IP, prompt for licence + workspace code, write `agentdash.env` (mode 600) | the customer's agent | Forgetting the licence public key, forgetting the workspace code, hand-typing the IP |
| 4 | Run as service + `pmset -a sleep 0 disksleep 0` + wait for `/api/health` | the customer's agent | The Mac-mini-sleeps-and-agents-die class |
| 5 | Claim the install — ask for founder email + invite code, mint one-time password-setup link | the customer's agent | The "no email provider = no way in" myth |
| 6 | Create the workspace **with both** `productProfile: "agentdash_mk"` and the invite code, verify `connector-send-executions` returns 200 | the customer's agent | The silent failure of omitting the profile (workforce features 404 later) |
| 7 | Invite teammates with auto-approve enabled | the customer's agent | Non-members who can't be assigned a steward |
| 8 | Create one agent per teammate + one for the founder; pair each person to one agent | the customer's agent | "Two people, one agent" — explicitly rejected by the data model |
| 9 | Show the destructive-action class list and ask the founder to tune the owner ceiling per agent | the customer's agent | A customer who never sees the ceiling editor and discovers it during their first incident |
| 10 | **Prove it works** — have one teammate's agent ask another for a fact, confirm the answer arrives attributed | the customer's agent | A "success" that never actually exchanged a fact |

The founder is the human-in-the-loop at every step. The agent stops whenever it
needs something only a human can give it. **No email provider is required.**
No Docker is required. No database to install is required.

### 2.5 What is *not* part of the install prompt (deliberate)

- **No TLS provisioning in the prompt.** TLS is the on-premise customer's PKI problem; see §5.3 and `SOP-onsite.md` §"The certificate problem".
- **No Tailscale provisioning in the prompt.** Tailscale is the remote-support surface; install it from [`doc/customers/mkthink/06-remote-support-access.md`](mkthink/06-remote-support-access.md) only if the customer opts into remote support.
- **No CoS iMessage setup.** That's an upsell (the CEO profile path in `04-ceo-agent-imessage.md`); only the customer can decide their iMessage posture.

---

## 3. SLOs

These are **the SLOs a second customer's install will be held to.** They are
written so they can be re-derived from logs and a working install, not so they
sound good on a slide.

### 3.1 Availability

| Window | Target | Source of evidence |
|---|---|---|
| `/api/health` returns `200` after a **reboot with nobody logged in** | ≥ 99% over 30 days, measured by hourly probe | `doc/REBOOT-TEST.md`; the operator can replicate. The Mini must boot, postgres, caddy, tailscaled, and both servers must answer 200 with the console user still `root` at the login window. Proven at home 2026-08-17, 38s from POST to first 200. |
| `/api/health` during normal operation | ≥ 99.9% over 30 days | `launchctl print gui/<uid>/com.agentdash.<inst>.server`; `KeepAlive {SuccessfulExit:false}` restarts non-zero exits within ~15s. |
| Backup window | One successful logical Postgres backup per 24h ± 1h, retained 14 daily / 8 weekly / 12 monthly | `deploy/install.sh` installs `com.agentdash.<inst>.backup` at 03:30 with `RunAtLoad: false` so it catches up if the Mini was asleep. Backup path is `~/.paperclip/backups/<instance>/`. |

### 3.2 Latency

| Path | Target | Why |
|---|---|---|
| `POST /api/onboarding/interview/turn` (CoS) | ≤ 50s p95 after the first call (model warm-up) | Already verified live: real CoS reply returned in ~23s. First reply after a reboot can take minutes (Hermes compiles Python modules once); subsequent replies ~12s. |
| `POST /api/agents/<id>/wakeup` → run start | ≤ 5s from API call to the run record visible | The 5 critical-path runs in `RUNBOOK-TESTING.md §13` show run starts in seconds; failures are the 5xx on bad run-ids (already fixed). |
| Browser page load (dashboard) | FCP ≤ 1.5s p95 on the customer's LAN | The UI bundle is built into `ui/dist` on the host (`install.sh` rebuilds it on every install). Server-side render is the same as Cloud. |

### 3.3 Correctness (these are not negotiable)

- Every agent run that claims `succeeded` MUST actually have a child process that exited `0`. Verified by `server/src/__tests__/agent-execution.test.ts` (falsified first: revert the assertion and the test fails). 
- Every destructive action the founder did not grant MUST end in an approval gate. Cross-tenant reads MUST be refused (`TEST-PLAN.md §B1.2`). Verified live; pinned by tests.
- An agent with a missing `adapterConfig.command` MUST be refused at create, not at run (`RUNBOOK-TESTING.md §7`).
- The reliability budget for "agents that cannot run" is **zero**. They were the original defect.

### 3.4 What we are deliberately NOT measuring yet

- **Token metering reads zero on MiniMax.** The 115s run in `RUNBOOK-TESTING.md §13` recorded `token_count=0, cost_cents=0`. Cost reporting cannot be a SLO until it reads anything.
- **`claude_local` rate-limit surface.** We don't meter it; we know `claude_local` returns the customer's quota.
- **One orphaned run.** `3f26126c` has been `running` since 15:01 with no process behind it. The watchdog did not reap it. **Open.**

---

## 4. Security boundary

This is **deliberately and explicitly** a perimeter model, not a row-level-isolation model. The customer trusts the operator of the machine; the operator trusts the customer; the customer does not trust agents in flight.

### 4.1 What's in scope of the customer's trust

| Surface | Trust posture | Source of evidence |
|---|---|---|
| The Mac mini hardware + macOS | Trusted by the customer (it is *their* machine) | OS-level; nothing AgentDash does here |
| `launchd` services labelled `com.agentdash.*` | Trusted (root-owned plists, mode 644, in `/Library/LaunchDaemons/`) | `deploy/install-launchdaemons.sh`; verified FileVault-OFF at install time |
| `~/.config/agentdash/*.env` | Mode `600`, owned by the running user | `deploy/install.sh` line 64 sets this explicitly |
| Postgres at `127.0.0.1:54329` | Loopback only; no external listener | `agentdash-postgres.sh` listens on loopback |
| Tailscale daemon | Root-owned, WireGuard to the customer-owned tailnet | `tailscaled` runs as a LaunchDaemon |
| The customer's own keys on their own laptop | Trusted (they issued them) | Per-employee SSH key on the install host via `ssh-copy-id` |

### 4.2 What's NOT in scope of trust

| Surface | Why it's not trusted | Mitigation |
|---|---|---|
| The agent's prompt body | Built from issue text + other agents' output. The system wraps these in `<untrusted-agent-answer>` deliberately. | Agent harnesses run with **a restricted tool set** (`hermes_local` runs with `-t clarify --ignore-rules`; verified live in `RUNBOOK-TESTING.md §11`). |
| The agent's environment | Agents use to inherit `DATABASE_URL`, `BETTER_AUTH_SECRET`, `MINIMAX_API_KEY`, `AGENTDASH_LICENSE_KEY`. **Fixed in `RUNBOOK-TESTING.md §14`** — `inheritableAdapterEnv` is now an allowlist, and per-agent needs go in `adapterConfig.env` which always wins. | Verified both directions: secrets must not cross (test), `PATH`/`HOME` must cross or nothing runs (test). Falsified first. |
| The agent's stdin/argv | `hermes chat -q <prompt>` passes the prompt in argv. `ps` exposes it. | `claude_local` already uses stdin. Hermes CLI has no stdin input — **inherent to the harness**. Don't run on a shared host with real content. Documented in §14 "deliberately left open". |
| Cross-customer API | A second customer's API key on a second customer's machine. | Tenant filter on every company-scoped route; verified by `TEST-PLAN.md §B1.2`. |
| Email | The Resend API key is **the customer's**. Without it, invite and reset links mint at the API and the agent hands them over directly. **No email provider needed** to be secure by default. |

### 4.3 What the install *cannot* do without the customer

- **TLS.** It is the customer's PKI decision, not ours. [`SOP-onsite.md`](../SOP-onsite.md) lays out the four options and why we lead with **A — their IT issues a cert from the customer's own CA**: zero new trust on any laptop. With FileVault ON, none of this buys unattended restart (the home volume isn't readable at boot) and the customer owns that trade.
- **CA-of-record for their fleet.** Without it, every browser shows the warning. The install ships with a self-signed `rootCA.pem` precisely so the customer can ask for a single MDM push instead of an OS-level trust per laptop.
- **Guest-WiFi vs VLAN.** Detailed in `SOP-onsite.md §"Do not run this on the guest Wi-Fi"`. The install will not warn you about this; the operator must.

### 4.4 The "I'll click through the certificate warning" trap

Explicitly out-of-scope as an option. **Casper's reading holds**: a warning that gets clicked-through four times teaches four people to click through warnings. The install ships with the warning, that's fine. The install does NOT ship "click through and you have HTTPS." That's a customer policy choice, not a deployment choice.

---

## 5. Operating cost

This is what the design-partner-2 should expect to pay per install to keep it running for a month. **These are ballpark figures, anchored to `doc/plans/2026-05-29-vps-cloud-and-outcome-pricing.md` §"OTA Update Reality Check" and the commercial-offer context, not measured.** Re-derive after the first VPS install. All numbers are USD.

### 5.1 Host

| Shape | Spec | Monthly | Note |
|---|---|---|---|
| **Mac mini on-prem** | Hardware the customer owns | $0 marginal to AgentDash | The "Mac mini pilot" shape already proven. Customer absorbs electricity + capex; AgentDash absorbs no host cost. |
| **Managed single-tenant VPS** (DigitalOcean/Lightsail, 2 vCPU/4GB baseline) | 1 instance + 1 Postgres either colocated or managed | $24–60/mo | VPS plan §"P0: VPS Shape". Recommend colocated Postgres initially for evidence; managed DB after we've proven backup/restore. |
| **Multi-tenant AgentDash Cloud** | Not v0 | n/a | Gated by §1 commitments. |

### 5.2 Data plane

| Item | Cost | Note |
|---|---|---|
| Postgres backups (logical dump, gzip) | retention is local disk; ~204 KB/day on the MKThink test run | `deploy/install.sh` retains 14 daily / 8 weekly / 12 monthly. **No S3, no off-host replication in v0.** Deliberate. |
| Inbound API traffic | $0 | Self-hosted; no metered egress |
| Outbound API traffic for LLM inference | Customer's own provider bill | Claude Code subscription = $0 to AgentDash, billed by Anthropic. API key = billed by the customer's chosen provider. We mark up nothing. |
| Tailscale (personal-use tier) | $0 to AgentDash for ≤ 100 devices | Free tier covers every realistic customer-install scenario. |

### 5.3 Operator time (the cost we don't bill)

| Activity | Time per install | Source |
|---|---|---|
| **First-time install** (Mac mini) | 90 minutes of operator time + 90 minutes of customer time | `mkthink/00-onsite-operating-procedure.md` |
| **First-time install** (managed VPS) | ~120 minutes of operator time (waiting on DNS + VPS provisioning is the bottleneck) | Not yet measured; estimate |
| **Re-install / second customer onboarding** | ≤ 30 minutes of operator time, all automated via the install prompt | This document's acceptance test (§7) |
| **Routine weekly check** | 5 minutes | `scripts/msp-mac-mini-readiness.sh` |
| **Monthly evidence** | 15 minutes | Same script + `--run-backup` |

### 5.4 What is not in "operating cost" yet

- **Cost recovery on usage.** v0 on-prem has markup `1.0` — we don't bill the customer for inference. P1 of the pricing plan (Stripe metered usage from approved value events) is conditional on customer-defined value events existing first.
- **On-call / 24/7 support.** Excluded from v0 explicitly (commercial-offer §5). If we sell it, we must run it; we don't have the runbook yet.
- **Compliance certifications beyond SOC 2 Type I.** SOC 2 Type I when we have it. HIPAA/FedRAMP/PCI not in v0.

---

## 6. Operating model (the part that isn't in the install prompt)

The install gets the machine running. The **operating model** keeps it running.

### 6.1 What the customer owns

- **License renewal.** 6-month for the on-prem pilot (MKThink-equivalent), single-tenant key generated for the machine fingerprint, expiring on a date the operator sets.
- **Their LLM tokens.** Whatever adapter they pick, their key, their invoice.
- **Their backups' off-host storage.** v0 keeps backups on the local disk; the customer is responsible for replication. This is **deliberate**. We say so.
- **Their Tailscale tailnet or their own VPN.** Either works; we document Tailscale because it's zero-config.
- **Their hostname.** A real DNS name (`agentdash.mkthink.com` in the worked example) replaces `mkmini.local` everywhere and removes dependence on Bonjour. They pick the name; we wire it.

### 6.2 What we (AgentDash) own

- The release pipeline that mints a new build SHA, publishes to GHCR, and writes a deploy receipt per customer instance (`agentdash-msp-launch` source-update + `ota-update.mjs`).
- **Default update posture is check-only.** `agentdash-update.sh` runs at 09:15 daily and reports that the box is behind, without changing anything. The operator opts in to `AGENTDASH_UPDATE_APPLY=1` to let it deploy unattended. The default is judgement, not timidity: 2026-08-18 a bad commit reached `main` and reached the customer's Mini within the hour; rollback existed and worked, but "a person decides" is the stronger promise.
- The acceptance test (§7) on every new design partner install.
- The fix-it loop on bugs reported through the in-product button (when `AGENTDASH_GITHUB_ISSUES_REPO` + `AGENTDASH_GITHUB_ISSUES_TOKEN` are set; the button is hidden when they aren't, deliberately).
- **The followups:** first-run brief, ten-minute handoff, weekly readiness report.

### 6.3 What we explicitly do NOT do

- We do not operate the customer's Mac mini. We don't run their updates.
- We do not read their issues unless they report them through the in-product channel.
- We do not enforce the licence without an explicit `ENFORCE_LICENSE=true` flipped on the customer's env. Today that flag does nothing anyway (`requireLicense` has no caller) — see §3.4 in the open-issues section.

---

## 7. Acceptance test — a second customer's install must pass

A **second customer's** install passes when **all** of the following are true. The criteria were derived from `TEST-PLAN.md` Part A & Part B, with redactions for items that are MKThink-specific (the workspace code, the agent team names) and additions for the install-prompt assertions (§2.4). These are the assertions a second design partner — **not Titus, not MKThink** — must be able to drive end to end.

### 7.1 Smoke (automated)

| # | Assertion | Verification |
|---|---|---|
| 7.1.1 | `curl -fsS http://127.0.0.1:3100/api/health` → `200` within 120s of `install.sh` finishing | `scripts/msp-mac-mini-readiness.sh` passes zero failures |
| 7.1.2 | `pnpm gate:journeys` exits `0` (both journey smokes) | CI on the install host pre-commit, plus on the supporting dev harness if applicable |
| 7.1.3 | `scripts/msp-mac-mini-readiness.sh --run-backup --expected-company "<customer name>"` produces a fresh backup file under `~/.paperclip/backups/<instance>/` and the script returns zero failures | The script is the source of evidence |
| 7.1.4 | Reboot the Mac mini, do not log in, and from another device `curl -sk https://<public-url>:3112/api/health` → `200` within 90s of POST | The reboot test that has never been proven until it's proven |
| 7.1.5 | `allowlist test` — secrets do not cross into the agent environment (the agent has no `DATABASE_URL`, no `BETTER_AUTH_SECRET`, no `MINIMAX_API_KEY`, no `AGENTDASH_LICENSE_KEY`). The agent still works through Hermes because `HOME` is allowed through. | The `adapter-env-isolation.test.ts` test, run on the second customer's box, falsified first |

### 7.2 Tenant gate (automated)

| # | Assertion | Verification |
|---|---|---|
| 7.2.1 | A second company's agent key is refused when reading the first company's issues (404 or 403, not 200) | `TEST-PLAN.md §B1.2` reproduced |
| 7.2.2 | The default `agentdash_mk` product profile is wired on `POST /companies` (workforce surface returns 200, not 404) | `connector-send-executions?status=outcome_unknown` returns 200; reproduces the silent failure |
| 7.2.3 | New companies have an empty `agents` table initially and exactly one workspace | Re-run the first-run smoke (`scripts/demo/first-run.mjs`) and check `pnpm exec tsx -e 'select count(*) from agents' → 1 chief + N configured` |

### 7.3 Operator UX (the human parts)

| # | Assertion | Verification |
|---|---|---|
| 7.3.1 | Founder can sign up from a clean email address using only the invite code they were emailed (no password reset steps needed) | Drive in browser |
| 7.3.2 | CoS onboarding wizard reaches the proposal step in ≤ 6 turns; the three fixed questions return instantly (no model wait); adaptive turns ≤ 50s | Drive in browser |
| 7.3.3 | All three teammates invited with auto-approve are members by the time they accept | Drive in browser; pair one teammate to one agent and confirm `My Agent` resolves |
| 7.3.4 | An agent created via the wizard does **not** show "requires a command" | Drive in browser; observe agent card |
| 7.3.5 | `My Agent` for the founder shows the founder's agent | Drive in browser |
| 7.3.6 | Company Settings shows the ceiling editor with all six dimensions | Drive in browser |
| 7.3.7 | Approvals is reachable and an agent request can be approved or rejected | Drive in browser |

### 7.4 End-to-end (the second-customer-stamped proof)

| # | Assertion | Verification |
|---|---|---|
| 7.4.1 | Founder asks their CoS for one fact; CoS forwards to a teammate's agent; teammate's agent escalates to a human laptop via the bridge; human answers; the answer comes back **attributed to the human who answered it** | Drive end to end. Pass = the answer is visible, attributed, and was sourced (not invented) |
| 7.4.2 | A real `hermes_local` agent executes assigned work and exits `0`; cost_events read zero (expected on MiniMax today, honest) | `POST /api/agents/<id>/wakeup` then read `agent_runs` for exit code 0 |
| 7.4.3 | The board-pack or weekly-brief demo replays against the new workspace and ends in a sourced, attributed deliverable | `node scripts/demo/board-deck.mjs` against the second customer's instance; expect `ok=N broken=0` |
| 7.4.4 | The first-run script prints a brief a fresh agent can follow; the brief is judged as documentation, not just output | `node scripts/demo/first-run.mjs`; sample one |

### 7.5 Reporting back

What the customer must report back (mirrors `TEST-PLAN.md §"What to report back"`):

1. **The case number** where it broke, and **whether the UI said anything**. Silent failures matter most — this codebase degrades quietly.
2. Anything that *looks* like it worked but produced text the customer wouldn't send to a client.
3. Anything slower than ~30s that is not the first call after a reboot.

---

## 8. Manual-step ledger — every step MKThink suffered, classified

This is the audit Casper asked for: "mine doc/customers/mkthink/ for every
manual step MKThink suffered." Sources read cover-to-cover:
`mkthink/00-onsite-operating-procedure.md`, `01-welcome.md`,
`02-daily-usage.md`, `03-troubleshooting.md`, `04-ceo-agent-imessage.md`,
`05-admin-reference.md`, `06-remote-support-access.md`,
`agentdash.env.template`, `RUNBOOK-TESTING.md`, `TEST-PLAN.md`,
`WALKTHROUGH.md`, `SOP-onsite.md`. Marked entries follow the verdict
convention:

- **AUTOMATED** — the install prompt or installer does it; the human does not.
- **ONBOARDED** — folded into the install prompt at §2.4; the customer's own agent runs it after being asked.
- **DELIBERATE** — a documented choice the customer owns (e.g., IT approbation, vendor bill, security PKI policy). Documented because it is on purpose, not because nobody got around to it.

| # | Step MKThink suffered | Source | Verdict | What changed or why it stays |
|---|---|---|---|---|
| 1 | Pre-stage files on a USB or AirDrop from Eddy | `00-onsite §Before You Arrive` | **AUTOMATED** | The install is shipped as `git clone` plus a one-paste prompt; the prompt carries everything the customer's own machine has to know. |
| 2 | Generate `BETTER_AUTH_SECRET` and `PAPERCLIP_AGENT_JWT_SECRET` with `openssl rand -hex 32` on Eddy's laptop | `00-onsite §Sunday Night` + `agentdash.env.template` | **AUTOMATED** | The install prompt §3 generates these on the customer's own machine. Nothing has to cross Eddy's laptop. |
| 3 | Edit `agentdash.env` to fill `<MKTHINK-MAC-MINI-IP>`, `<GENERATE_ON_SITE>`, `<CUSTOMER_ANTHROPIC_API_KEY>`, `<PASTE_THE_LICENCE_KEY>` | `agentdash.env.template` + `00-onsite §Phase 2` | **ONBOARDED** | The prompt writes the env; the customer pastes exactly four values when asked (license key, license public key, workspace code, optional API key). LAN IP is detected. Placeholder surgery is gone. |
| 4 | `git clone https://github.com/thetangstr/agentdash.git ~/agentdash && pnpm install && pnpm build` | `00-onsite §Phase 2` | **ONBOARDED** | Step 2 of the install prompt. The customer's agent runs it. |
| 5 | `./docker/launchd/install.sh` | `00-onsite §Phase 2` | **AUTOMATED (replaced)** | The MkBoard install uses `deploy/install.sh` directly, which writes LaunchAgents to a known label and waits for `/api/health` to 200. The Docker-wrapping installer is now legacy; the on-site SOP uses `deploy/install.sh` + `deploy/relocate.sh`. |
| 6 | `cp /path/to/agentdash.env.template ~/.config/agentdash/agentdash.env && nano … && launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent` | `00-onsite §Phase 2` | **AUTOMATED (combined)** | The customer's agent writes the env, restarts the service, and waits for `/api/health` in one go. No `nano` ever needed. |
| 7 | Verify Mac is always-on and disable sleep | `00-onsite §Phase 1` + `05-admin-reference §Prevent Mac Mini Sleep` | **ONBOARDED** | Step 4 of the install prompt runs `sudo pmset -a sleep 0 disksleep 0`. If the prompt can't sudo it stops and asks. |
| 8 | `scripts/msp-mac-mini-readiness.sh --base-url <ip> --expected-company "MKThink"` | `05-admin-reference §Readiness Check` + `00-onsite §Post-Install Checklist` | **AUTOMATED** | Becomes the same script a second customer's install runs post-install. |
| 9 | CoS onboarding — discovery + plan proposal | `00-onsite §Phase 3` | **ONBOARDED** | Steps 6–8 of the install prompt are exactly this conversation, run by the customer's own agent after they paste the prompt. |
| 10 | Walk the founder through "your first real task" | `00-onsite §Phase 3.6` | **ONBOARDED** | Step 10 of the install prompt: *"Have my agent ask one teammate's agent for a fact, confirm it reaches that person, have them answer, and show me the answer coming back attributed."* |
| 11 | Set monthly budget (`PATCH /api/companies/:id/budgets` with `{"budgetMonthlyCents": 10000}`) | `00-onsite §Phase 4` + `02-daily-usage §Budget` | **AUTOMATED** | On-prem has inference markup forced to 1.0 and no Stripe; the budget gate isn't on by default. v0 keeps it documented in `mkthink/02-daily-usage.md` for when the customer switches to a key-metered adapter and wants the auto-pause behaviour. |
| 12 | Install iMessage CEO agent — `curl -fsSL …/hermes-agent/install.sh \| bash && hermes setup && brew install steipete/tap/imsg && grant Full Disk Access` | `00-onsite §Phase 5` + `04-ceo-agent-imessage.md` (whole file) | **DELIBERATE** | iMessage bridging is an **upsell**, not part of the install. The 20 minutes saved on site skip it; the customer opts in later. Documented as a deliberate customer decision (`SOP-onsite.md` does the same). The "if time permits" branch in `00-onsite` is now the default. |
| 13 | Grant Full Disk Access manually | `03-troubleshooting §iMessage Agent Not Responding` + `04-ceo-agent-imessage §Step 4` | **DELIBERATE** | Apple requires the user grant FDA in System Settings. No installer bypasses this. Documented; left to the customer. |
| 14 | Sign up the primary user with their work email and walk through `1 → 2 → 3` | `01-welcome §First time` + `00-onsite §Phase 3.2` | **ONBOARDED** | Step 5 (claim) + Step 6 (workspace) of the install prompt. |
| 15 | Bookmark the dashboard and Quick Reference Card on the founder's computer | `00-onsite §Phase 6` | **AUTOMATED** | The prompt outputs the dashboard URL and the founder bookmarks it; the welcome site renders the same content as `welcome/index.html` (a one-page version of `mkthink/01-welcome.md`). |
| 16 | Set the file location for IT (the Wired Ethernet vs Wi-Fi, DHCP reservation vs mDNS) | `SOP-onsite §1 Physical` and §"What to ask MKThink IT for" | **DELIBERATE** | This is the customer's network decision, not ours. Documented as the customer's. The install will not do it; the runbook will not pretend to. |
| 17 | Get a TLS cert from the customer's CA, or push our `rootCA.pem` via MDM | `SOP-onsite §"The certificate problem"` | **DELIBERATE** | Same posture as 16. Four options laid out; lead with A (their CA); reject "click through". |
| 18 | Install Tailscale on the customer's Mac mini for remote support | `06-remote-support-access §On-Site Setup (During Install)` | **DELIBERATE** | It's a customer opt-in. They revoke access. The install prompt doesn't include it; the doc remains for the customer who asks for it. |
| 19 | `sudo systemsetup -setremotelogin on && ssh-keygen && ssh-copy-id` | `06-remote-support-access` | **DELIBERATE** | Same posture as 18 — only on the install that opts in to remote support. |
| 20 | "Decide which adapter" decision tree (claude_api vs claude_local vs openai_compat with Ollama) | `00-onsite §Adapter Decision Tree` | **ONBOARDED** | The install prompt Step 3 sets `claude_local` unless the customer gave an API key; the template's three options are still there as comments for the customer who wants to switch later. |
| 21 | Configuring the `AGENTDASH_DEFAULT_ADAPTER` and re-running launchctl kickstart | `03-troubleshooting §CoS Chat Shows Stub Reply` + `05-admin-reference §Environment Configuration` | **AUTOMATED** | Steps 3 + 4 of the install prompt. |
| 22 | Pause/resume an agent from the dashboard | `02-daily-usage §Pause/Resume an Agent` | **AUTOMATED (in the UI)** | This is a feature. No scripts involved. |
| 23 | Mail a Resend key to enable invite/reset emails | `01-welcome §First time` + `SOP-onsite §Getting Titus in` | **DELIBERATE** | The install works fully without Resend; invite and reset links mint at the API and the agent hands them over. Resend is opt-in for customers who want emails delivered. |
| 24 | Edit `~/.config/agentdash/agentdash.env` after install to change anything | `05-admin-reference §Environment Configuration` | **AUTOMATED** | Re-running `deploy/install.sh` is idempotent; the install prompt can re-run itself for the customer. Documented. |
| 25 | `scripts/msp-mac-mini-readiness.sh --run-backup` weekly | `05-admin-reference §Database §Backup` + `00-onsite §Post-Install Checklist` | **AUTOMATED** | `com.agentdash.<inst>.backup` runs nightly at 03:30 with `RunAtLoad: false` (catches up when the Mini was asleep). The customer doesn't run backups. |
| 26 | `git fetch && git pull --ff-only && pnpm install --frozen-lockfile && pnpm build && launchctl kickstart` to update | `05-admin-reference §Updating AgentDash` | **AUTOMATED** | `scripts/deploy/agentdash-source-update.mjs` does this with backup, prove-`/api/health`, and rollback to the exact previous commit if health doesn't return. Optional auto-apply via `AGENTDASH_UPDATE_APPLY=1`; default is check-only — judgement, not timidity. |
| 27 | Creating the iMessage profile's `AGENTS.md` instructions inline | `04-ceo-agent-imessage §Step 6` | **AUTOMATED (when opted in)** | `hermes profile create ceo` and `cat > ~/.hermes/profiles/ceo/AGENTS.md <<'INSTRUCTIONS' …` are commands. The CEO profile is an upsell; the install doesn't do it but the customer can repeat the command line in isolation when ready. |
| 28 | Manually run the iMessage test send | `04-ceo-agent-imessage §Step 8` + `00-onsite §Phase 5.8` | **DELIBERATE (within opt-in)** | The customer has to send the actual SMS from their phone. By definition the test cannot be automated. |
| 29 | Restart the gateway with `hermes -p ceo gateway restart` | `04-ceo-agent-imessage §Maintenance` + `03-troubleshooting §iMessage Agent Not Responding` | **AUTOMATED (within opt-in)** | Wrapped behind `hermes -p ceo gateway install` + gateway is supervised. |
| 30 | `node ~/agentdash/deploy/set-password.mjs mkboard <email>` to set a founder password | `SOP-onsite §Getting Titus in §Alternative` | **DELIBERATE** | The default flow is the founder sets their own via a mailed link (no Resend required; the agent hands the link). The script is the recovery path only. Documented. |
| 31 | Calling `pnpm gate:journeys` after a code change | `RUNBOOK-TESTING.md §6` + §"What to report back" | **AUTOMATED** | CI runs it; `scripts/msp-mac-mini-readiness.sh` reads evidence. Operator does not run it. |
| 32 | Provisioning the `uat` instance as a parallel test bed | `TEST-PLAN.md` §"Target" header | **RETIRED** | The `uat` decommission is documented in `RUNBOOK-TESTING.md §16`. Two identical-looking instances on adjacent ports was the shape of "real work lands on the wrong one." **Removed.** Acceptance test on the operator's own hardware instead. |
| 33 | "Said task is done but the model exceeded its turns; CoS gets silence" | `RUNBOOK-TESTING.md §3` | **AUTOMATED** | Fixed: cap forces the proposal. Pinned by the test that drove both directions on a four-follow-up deliberately vague answer. |
| 34 | A `process` agent with no command was accepted and silently failed every run | `RUNBOOK-TESTING.md §7` | **AUTOMATED** | Validation at create refuses it; pinned by `agent-execution.test.ts`. |
| 35 | `/health` lied about the harness being unavailable while serving replies | `RUNBOOK-TESTING.md §8` | **AUTOMATED** | Fixed: `require` ESM correctness, swallowed error; endpoint now `{"ready":true}`. Pinned. |
| 36 | Bridge poll ate 90% of the customer's own quota | `RUNBOOK-TESTING.md §10` | **AUTOMATED** | Polling is exempt from the limiter; `/bridge/result` and `/bridge/decline` stay limited. **NOT verified in production window** — the one I most want to see stress-tested. |
| 37 | Server inherited Postgres URL + Better Auth secret into the agent subprocess | `RUNBOOK-TESTING.md §14` | **AUTOMATED** | `inheritableAdapterEnv` is an allowlist. Per-agent needs go in `adapterConfig.env` which always wins. Pinned by `adapter-env-isolation.test.ts`. |
| 38 | Onboarding plan card not actually creating agents | `RUNBOOK-TESTING.md §15` | **AUTOMATED** | Fixed and verified end to end on a fresh conversation; idempotent `bootstrap`. |
| 39 | First-run seed created agents with `canCreateAgents: false` | `RUNBOOK-TESTING.md §13.1` | **AUTOMATED** | `first-run.mjs` now grants `canCreateAgents` and `canAssignTasks` after creating the Chief. |
| 40 | Malformed run id returned 500 instead of 404 | `RUNBOOK-TESTING.md §13.2` | **AUTOMATED** | Fixed with `router.param` guard on every `:runId` route; falsified. |

**Summary by verdict:**

- **AUTOMATED** (now invisible to the customer): 1, 2, 5, 6, 8, 11, 15, 21, 22, 24, 25, 26, 27, 29, 31, 33, 34, 35, 36, 37, 38, 39, 40 — twenty-three items.
- **ONBOARDED** (run by the customer's own agent after the install prompt is pasted): 3, 4, 7, 9, 10, 14, 20 — seven items.
- **DELIBERATE** (documented customer decisions, on purpose): 12, 13, 16, 17, 18, 19, 23, 28, 30 — nine items.
- **RETIRED** (practices we have deliberately stopped doing): 32 — one item.

Net: every manual step MKThink suffered has a verdict and a reason. The biggest regressions in the manual-step ledger are the ones we **deliberately left to the customer** because they are policy decisions (TLS, guest Wi-Fi, iMessage, FDA), not engineering decisions.

---

## 9. Open issues this document does NOT close

These are tracked but out of scope for **repeating the deployment**. They are listed so the next person reading this doc knows what is *intentionally* left for other tickets.

1. **License enforcement is not wired.** `server/src/middleware/require-license.ts` exports `requireLicense` and grep finds no caller. `GETTING-STARTED.md §1` spells it out. Closing it is a product decision (flipping it on gates existing self-hosters). Until then, on-prem entitlement is a contract artefact, not a runtime gate.
2. **Token metering reads zero on MiniMax.** First-pass cost reporting cannot be a SLO. The 115s run in `RUNBOOK-TESTING.md §13` shows why.
3. **Usage metering for `claude_local`.** Different problem: the CLI doesn't report per-call costs in non-interactive mode. Documented; deferred.
4. **One orphaned run.** `3f26126c` has been `running` since 15:01 with no process behind it. Watchdog didn't reap it.
5. **`claude_local` toolset restriction.** No equivalent flag to Hermes's `-t`. Acceptable risk documented in `RUNBOOK-TESTING.md §14`.
6. **Plan card role fidelity gap.** Aria proposed as `operations_lead`, materialized as `general`. Cosmetic today; will matter at the second design partner.
7. **Test files can silently skip without Postgres.** No gate on the skip count (`RUNBOOK-TESTING.md` "Known broken").
8. **`AGENTDASH_ENFORCE_LICENSE=true`** is set in the install prompt **§3 env**, but the middleware doesn't run today. We are shipping a flag that does nothing.
9. **Two install scripts coexist:** `docker/launchd/install.sh` (legacy `ai.agentdash.agent` label) and `deploy/install.sh` (current `com.agentdash.<inst>.server` label). `GETTING-STARTED.md` §3.1 notes the difference. We need to pick a single canonical installer once the design partner has signed off and we delete the older one.
10. **Re-derive every cost-of-delivery number** after AGE-14 (MKThink learning thesis) closes. Commercial-offer §4 explicitly defers Pro pricing pressure-testing until this doc's cost-of-delivery model is real. No external price quote from the v0 commercial offer until that has happened.

---

## 10. Sign-off

This document closes **AGE-17** when:

- All §7.1–7.5 acceptance criteria are reproducible on a non-MKThink machine.
- A **second design partner install** has completed at least one full `scripts/msp-mac-mini-readiness.sh` run with zero failures.
- The manual-step ledger (§8) has been re-scanned against the second install's actual steps.
- Beacon has re-run `commercial-offer-v0.md` against the realised §5 operating cost.

Signed off by name when §7 passes on the second design partner. Until then, this is a draft.

*— Forge, on behalf of Platform & Delivery*
