# Cloud MCP toolset: an agent gets a person an AgentDash cloud workspace

**Status:** built on `claude/cloud-mcp-toolset`; needs a staging run before it is announced (below).
**Date:** 2026-10-31
**Decision (product owner):** "Cloud MCP toolset". Any agent (Claude, ChatGPT, a company's own agent) can get a person a cloud box created and then set up their company, through MCP.
**Builds on:** the self-serve journey (`docs/superpowers/specs/2026-09-25-self-serve-cloud-design.md`), the hosted admission codes (runbook §10), the setup toolset's in-place sign-up (`agentdash_sign_up`), and the box's own CLI-auth approval.

## 1. The flow

| # | Who | What | Mechanism |
|---|---|---|---|
| 1 | agent | `agentdash_cloud_check_name(slug)` | the `/start` page's slug check |
| 2 | agent | `agentdash_cloud_start({email, slug, admissionCode?, acceptTerms})` → handle, once | `frontDoor.signup(…, "agent")`: the browser signup on an agent channel |
| 3 | person | clicks the verification email | unchanged `POST /api/cloud/verify` |
| 4 | — | waitlist or admission, then provisioning | unchanged queue gates |
| 5 | person | opens the claim link from their email, sets a password | unchanged `/claim` and claim sweep |
| 6 | agent | `agentdash_cloud_connect(handle)` → `approvalUrl` | `POST https://<slug>.agentdash.cloud/api/cli-auth/challenges`, made by cloud-control |
| 7 | person | signs in on the box, clicks **Approve** | the box's existing `/cli-auth/<id>` page |
| 8 | agent | `agentdash_cloud_connect(handle)` → board key, once; stdio upgrades in place | `setApiUrl` + `setApiKey`, setup tools added, `tools/list_changed` |

`agentdash_cloud_status(handle)` answers one of `email_pending`, `waitlisted` (`awaiting_approval` or `approved_waiting_for_capacity`, with the queue's gate), `provisioning` (step *n* of 5, `slow`), `awaiting_claim` (box URL only), `active` (box URL, `connected`), `failed` (`verification_expired`, `already_has_workspace`, `provisioning_failed`, `workspace_deleted`), each with plain `nextSteps`.

## 2. The connect choice: the box's CLI-auth approval

Two existing mechanisms ask a signed-in person to let a client in: the CLI-auth challenge (`POST /api/cli-auth/challenges`, approved at `/cli-auth/<id>`, which activates a pending **board key**) and assistant OAuth (`/api/mcp/assistant`). Connect codes mint agent keys for an existing agent, and a fresh box has none.

**Chosen: CLI-auth.** It is the only one that yields what the setup toolset needs: a board key acting as the person, the same credential `agentdash_sign_up` mints, so the interview, plan and hire tools work unchanged and the stdio session can upgrade in place. It is on every box release already, so connect needs no box change. Assistant OAuth stays the right path for OAuth-capable connectors that only relay (its toolset has no interview or plan tools); `connect`'s answer names it.

How it is bound to the handle and delivered once:

- cloud-control creates the challenge on the box (through the edge router, on the slug host derived from the box row, never from input), with the command "Connect the agent that set up this workspace" and client "AgentDash cloud setup agent", which the approval page shows.
- The challenge secret and the pending key are sealed under a key derived from the handle (HKDF-SHA256, salt the handle row id), then under `CLOUD_DATA_KEY`. The control plane cannot open them without a request carrying the handle, which it does not store.
- Each `connect` asks the box what the person decided. On `approved`, one conditional `UPDATE … WHERE connected_at IS NULL AND connect_challenge_id = …` wins; only that call returns the key, and the sealed state is erased. Later calls answer `connected, delivered: true`, never the key.
- The person's **Cancel** is a no: the handle answers `declined` until the agent passes `restart: true`. An expired request is replaced on the next call. Five requests per handle, ever, reserved before the box is asked, so concurrent calls make one request.
- The box reports `expired` before `approved` after a request's 10 minutes; an answer carrying `approvedAt` is treated as approved, so a timely approval is never thrown away. A restart cancels on the box first and then looks again, keeping an approval that landed just before. Only the box's own JSON "not found" counts as a vanished request; an edge page is "unreachable".
- **Confirmation code.** The box's create route is public, so anyone can make a request with the same words on any box. Each request carries a random code (`K7Q-4M2`) in the command the approval page shows, and the agent is told to have the person approve only if the page shows the code it gave them. A control-plane signature the box verifies would be stronger; it needs a box change and is left for later.

## 3. Security model

- **What the agent never receives:** the admin token, a password, the claim code or link, the verification link, or a browser session. Identity is the person clicking their email link and setting their own password on the claim page; agent access is the person's explicit approval on their box.
- **The handle:** `agdh_` + 32 random bytes, returned once, stored as SHA-256 only, bound to one signup (unique), expires after **7 days** (the claim link's lifetime), read-only except for connect, rate-limited per handle (status 240 an hour, connect 60 an hour, durable) and per address (120 lookups a minute). A leaked handle reads that one signup's status and can ask the person to approve; it cannot approve, and it reveals nothing about other signups.
- **No account oracle:** `start` answers an address that already has a workspace, or a blocked one, exactly like a new signup. It also records a decoy signup row (no email token behind it), so the name is held and holds are counted exactly as for a new address: "is this name still free?" cannot tell them apart. That handle reads `email_pending` and then `verification_expired`, as an unverified signup does. This closes the same check-name oracle on the browser path.
- **The abuse gate (Turnstile):** an agent cannot solve Turnstile, so the agent channel never runs it and every agent signup is recorded `unverified_human`. Its box needs an operator's approval (`needs_approval`, even with the waitlist off), exactly as a browser signup does while Turnstile is not configured. **A valid hosted admission code is the agent path's equivalent of the bot check:** it approves the box only after the person verifies their email. Turnstile also guards *sending* the verification email, so the agent channel has extra send limits: 2 links an hour per address (browser: 5); one hourly cap of 60 shared by every agent signup without an admission code, which bounds the mail a distributed caller can trigger (a code is exempt, so a flood cannot lock out invited people); and 3 signups an hour per code, because a code is spent only at verification. Everything else is shared with browser signup: email policy (disposable list, MX), slug holds, 3 signups an hour per address, 5 per email, 1 box a day per address, 5 per company domain, one Free box per verified email.
- **Shared egress:** a hosted assistant reaches the endpoint from its provider's addresses, which many people share. So for agent signups the one-box-a-day-per-address limit keys on the address of the person's verification click (recorded as the request's address), slug holds count by email only, and a valid code exempts its holder from the per-address signup limit (the per-code limit applies instead). Code-less agent signups still share 3 an hour per address; see §6.
- **Provisioning cost stays gated:** no new path reaches the queue; the kill switch, claim capability, waitlist, approval and daily cap apply unchanged (`requestProvision`).
- **Logs:** the redacting logger now also masks `agdh_…` and `pcp_…` values; nothing logs a handle, challenge secret or key.

## 4. Transports and code reuse

- **stdio:** `AGENTDASH_TOOLSET=cloud` (`AGENTDASH_CLOUD_URL`, default `https://www.agentdash.cloud`), no instance URL until connect. Calls `POST /api/cloud/agent/<op>` with the handle in the body, never a URL.
- **Hosted:** `POST /api/cloud/mcp` on cloud-control, reached through www's existing `/api/cloud/*` rewrite and middleware: stateless streamable HTTP, JSON responses, `GET`/`DELETE` 405, Origin must be www or absent, 120 messages a minute per address (a JSON-RPC batch counts per message, at most 10).
- **One definition:** `packages/mcp-server/src/cloud.ts` holds the tools; cloud-control runs them through `createAgentDashServer(…, { toolset: "cloud", cloud: { backend } })` with an in-process backend that calls the same dispatcher (`cloud/src/front-door/agent.ts`) the REST routes call, with the request's own visitor, so the limits are identical. Only stdio upgrades in place, and only to `https://<slug>.<edge domain>` whose API is its own `/api` (`isWorkspaceApi`); the stdio backend refuses redirects, so the handle is never re-sent elsewhere. The hosted answer carries the key once.

## 5. To enable it (founder or operator)

1. Deploy `cloud-migrate` (migration `0014_agent_handles`), then `cloud-control`. Its image now builds `@agentdash/mcp-server` first (`cloud/Dockerfile`).
2. Nothing new to configure: the endpoints are live with the front door. Keep `waitlist_mode=true`; issue admission codes with `admin invites add-hosted` to the people whose agents should get a box without waiting.
3. Announce `AGENTDASH_TOOLSET=cloud` and `https://www.agentdash.cloud/api/cloud/mcp` only after the staging check below.

## 6. Needs live verification

- A real run on staging: an agent start → real email → real box → claim → CLI-auth approval page through the edge router → connect → `agentdash_setup_status` on the box.
- That `POST /api/cli-auth/challenges` and `/cli-auth/<id>` work on hosted boxes behind the edge (the edge-secret gate, the board mutation guard, the sign-in redirect back to the approval page).
- The `/api/cloud/mcp` endpoint through Vercel's rewrite and middleware with a real MCP client.
- Per-address limits for hosted connectors that share egress addresses: code-less agent signups behind one address share 3 an hour, and the 60-an-hour shared cap can be exhausted by one caller (code holders are unaffected). Tune them once real traffic shows the shape.
- The approval page still says "Paperclip CLI"; a copy change on the box would read better for this flow (not required).
