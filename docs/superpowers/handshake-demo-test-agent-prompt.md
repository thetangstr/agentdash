# Test-Agent Prompt — Turnkey Two-Company Agent Trust Handshake Demo

> Paste everything below the line into a fresh agent. It is fully self-contained and fully automated: the agent runs every test case, records pass/fail against explicit acceptance criteria, and files GitHub issues for any failure — no human in the loop.

---

You are an autonomous QA agent. Your job is to test the **AgentDash two-company Agent Trust Handshake demo** end-to-end, validate every acceptance criterion, and **file a GitHub issue for each real bug you find**. Work entirely on your own — do not ask questions; if something is ambiguous, record it as an observation and continue.

## 0. Environment & ground truth (read first)

- **App under test:** a local AgentDash dev server at **`http://127.0.0.1:3100`**. The API base is `http://127.0.0.1:3100/api`. The web UI is served at the root.
- **Auth:** the server runs in `local_trusted` mode — an implicit **board actor** is injected, so **no token/login is needed**. `curl` and browser requests just work. (If `curl http://127.0.0.1:3100/api/health` does not return `{"status":"ok"}`, STOP and file a P0 "app not running" issue, then halt.)
- **Attestation is enabled** and pointed at the **real Clockchain testnet** (`mcp.clockchain.network`). Anchors are REAL but the validator pool is **degraded (single-validator)**: block heights are real, `consensusTime` is null, and receipts carry a `single-validator-testnet` disclaimer. This is expected — not a bug.
- **Companies (already seeded):**
  - `Meridian Pay` (the PAYER) — prefix `MER`, id `bfd324e2-6192-477d-be34-8a26010ec8c2`
  - `Trellis Freight` (the PAYEE) — prefix `TRE`, id `4ecef8ad-3723-483a-8d55-e4e2e04145b3`
  - Re-fetch live ids with `GET /api/companies` (names are stable; ids may differ if the DB was reset).
- **The demo's own agents:** `Iris` (Meridian, payer), `Billie` (Trellis, payee), `Atlas` (Meridian, CoS/grantor). The `/handshake-demo/go` endpoint seeds these if missing.

## Tools you have
- `curl` for the API (primary — most reliable).
- A browser automation tool for the UI checks (use whatever browser tooling you have; take screenshots as evidence).
- `gh` (GitHub CLI, already authenticated as `thetangstr`) for filing issues against `thetangstr/agentdash`.
- `python3` for parsing JSON in shell.

## How to read each test case
Every case has: **Where** (endpoint or UI route) · **Do** (the action) · **Expect (PASS)** · **Must NOT see (FAIL)**. A case PASSES only if every "Expect" holds and no "Must NOT" appears. Record every case's verdict in a running results table you print at the end.

---

## TEST SUITE

### TC-1 — App is alive
- **Where:** `GET /api/health`
- **Do:** `curl -sS http://127.0.0.1:3100/api/health`
- **Expect (PASS):** HTTP 200; body has `"status":"ok"` and `"instanceHasCompany":true`.
- **Must NOT see (FAIL):** connection refused; `status` != ok; `instanceHasCompany:false`.
- If FAIL: file a **P0** issue and halt the whole suite.

### TC-2 — Both demo companies exist
- **Where:** `GET /api/companies`
- **Expect:** the array contains a company named exactly `Meridian Pay` (prefix `MER`) and one named `Trellis Freight` (prefix `TRE`). Capture both ids into variables `MER` and `TRE` for later cases.
- **Must NOT see:** either company missing.

### TC-3 — Clockchain client is live (real gateway, correct contract)
This proves the Clockchain integration works against the real gateway (the field-mapping/`verify_delegation_at` bugs that were fixed).
- **Where:** the demo attestation path exercises it; but first a direct sanity check via the orchestrator (TC-7). For an isolated check, run the flag-gated integration test:
  `cd /Volumes/home/Projects_Hosted/ad/agentdash && AGENTDASH_ATTESTATION_ENABLED=true CLOCKCHAIN_MCP_KEY=$(grep CLOCKCHAIN_MCP_KEY server/.env | cut -d= -f2) CLOCKCHAIN_ALLOW_DEGRADED=true pnpm exec vitest run --project @paperclipai/server server/src/__tests__/mandate-integration.test.ts`
- **Expect (PASS):** `1 passed` — it mints identities, grants a mandate, KYAs, and attests against the live testnet.
- **Must NOT see (FAIL):** the test SKIPPED (means the flag/key isn't reaching it — file a config issue), or FAILED with a gateway/field error.

### TC-4 — Grant a mandate → REAL on-chain anchor
- **Where:** `POST /api/companies/{MER}/mandates`
- **Do:** first create two fresh agents in Meridian so the test is isolated:
  - `POST /api/companies/{MER}/agents` body `{"name":"QAGrantor","role":"ceo","adapterType":"hermes_local"}` → capture `GRANTOR`
  - `POST /api/companies/{MER}/agents` body `{"name":"QAGrantee","role":"general","adapterType":"hermes_local"}` → capture `GRANTEE`
  - Then POST the mandate:
    ```
    {"grantorAgentId":"{GRANTOR}","granteeAgentId":"{GRANTEE}",
     "scope":["release_payment"],"permissionKey":"clockchain:attest",
     "spendCapCents":100000,"expiresAt":"<now+7d as ISO8601 Z>"}
    ```
- **Expect (PASS):** HTTP 201; the returned mandate has a non-null `ccLedgerId` (a UUID) and `status:"active"`. Then **GET it back** (`GET /api/companies/{MER}/mandates?granteeAgentId={GRANTEE}`) and confirm `ccLedgerId` **persisted** (not null on re-read).
- **Must NOT see (FAIL):** `ccLedgerId:null` on the create response OR on re-read (means the anchor didn't persist); HTTP 500; `scope` echoed back as an object instead of the array you sent.
- **Bonus honesty check:** the grantor/grantee agents should now have a `clockchainDid` populated (`GET /api/agents/{GRANTOR}` → `clockchainDid` is a short `did:clockchain:agentdash:<16hex>`, NOT a UUID-form did). If it's a long UUID-form did, that's the bug the fix addressed — file it.

### TC-5 — Agent acts in-scope → REAL attested receipt
- **Where:** `POST /api/companies/{MER}/mandate-attestations`
- **Do:** `{"mandateId":"{the TC-4 mandate id}","action":"release_payment"}`
- **Expect (PASS):** HTTP 201; the returned row has `authorized:true`, `receiptStatus:"anchored"`, a non-null integer `blockHeight`, a non-null `ledgerId`, and a non-null `eventHash`.
- **Must NOT see (FAIL) — THIS IS THE CRITICAL HONESTY CHECK:**
  - `receiptStatus:"anchored"` **with `blockHeight:null`** → a false "anchored" claim. **P1 bug.**
  - `authorized:false` on an in-scope, under-cap, unexpired mandate.
  - `eventHash:null` on an authorized+anchored receipt (the self-verifying field must be populated).

### TC-6 — Out-of-scope action → bounce-back (deny + approval + pause), then resume
This is the human-in-the-loop path.
- **Where:** `POST /api/companies/{MER}/mandate-attestations` then the approvals API.
- **Do (a):** `{"mandateId":"{TC-4 mandate}","action":"delete_everything"}` (an action NOT in scope).
  - **Expect:** `authorized:false`, `reason:"out_of_scope"`, `receiptStatus:"denied"`, `escalated:true`, a non-null `approvalId`.
  - **Must NOT see:** `authorized:true` (a scope bypass — **P0**); `escalated:false`.
- **Do (b):** confirm the grantee agent is now paused: `GET /api/agents/{GRANTEE}` → `status:"paused"`, `pauseReason:"mandate"`.
  - **Must NOT see:** status still `idle`/`active` (pause didn't fire).
- **Do (c):** confirm the approval exists in the inbox: `GET /api/companies/{MER}/approvals` → an entry with `type:"mandate_violation"`, `status:"pending"`, `requestedByAgentId:{GRANTEE}`.
- **Do (d):** approve it: `POST /api/approvals/{approvalId}/approve` body `{}`.
  - **Expect:** approval `status:"approved"`; then `GET /api/agents/{GRANTEE}` → `status` is NO LONGER `paused` and `pauseReason:null` (the agent resumed).
  - **Must NOT see:** agent still paused after approval (resume didn't fire — **P1**).

### TC-7 — Over-cap action → over_cap bounce-back
- **Where:** `POST /api/companies/{MER}/mandate-attestations` — but this path doesn't take an amount, so test via the direct gate route:
  `POST /api/companies/{MER}/mandated-actions` body:
  `{"mandateId":"{TC-4 mandate}","counterpartyDid":"did:clockchain:demo:x","action":"release_payment","payload":{"amountCents":999999}}`
  (Note: this route forces the acting agent = grantee; as a board actor with no agent identity you may get `granteeAgentId is required` (400) — if so, record TC-7 as **N/A (route requires an agent actor)** and rely on the unit tests for over_cap coverage. Do not file a bug for the 400 here; it's the authz design.)
- **Expect (if runnable):** `authorized:false`, `reason:"over_cap"`.

### TC-8 — Cross-company mandate publishing (the new mechanism)
- **Where:** the publish/incoming/accept routes.
- **Do (a) publish:** `POST /api/companies/{MER}/mandates/{TC-4 mandate}/publish` body `{"counterpartyCompanyId":"{TRE}"}`.
  - **Expect:** HTTP 200; returned mandate has `published:true` and `counterpartyCompanyId:{TRE}`.
  - **Must NOT see:** error `mandate_not_anchored` (would mean TC-4's anchor didn't stick), or the publish silently not setting `published`.
- **Do (b) counterparty sees it:** `GET /api/companies/{TRE}/incoming-mandates`.
  - **Expect:** an array containing the published mandate, showing its `scope`, `spendCapCents`, and `ccLedgerId` — Trellis can see Meridian's mandate terms.
  - **Must NOT see:** empty array (cross-company visibility broken — **P1**); or the mandate's private internals beyond scope/cap/expiry/anchor.
- **Do (c) accept:** `POST /api/companies/{TRE}/incoming-mandates/{mandate id}/accept` body `{}`.
  - **Expect:** HTTP 200; returned mandate has a non-null `acceptedAt`.
- **Negative check:** try to accept a mandate that was NOT published to you — `POST /api/companies/{MER}/incoming-mandates/{some TRE-none mandate}/accept` should 400 `mandate_not_found`. (An accept from the wrong company must fail.)

### TC-9 — The turnkey "Go" orchestrator (the headline)
This is the one-button demo. It is **idempotent and resumable**: each `go` advances to the next gate and pauses at the two human approvals.
- **Where:** `POST /api/handshake-demo/go` (board-only; works as the implicit board actor).
- **Do (Go #1):** `POST /api/handshake-demo/go`.
  - **Expect (PASS):** `done:false`; `steps[]` shows `seed` = done, `discover` = done, and pauses at `onboard` = **waiting_approval** with an `approvalId`.
  - **Must NOT see:** `discover` blocked (means the gateway/flag is off); an unhandled 500.
- **Do (approve 1):** find the pending `clockchain_onboarding` approval in Meridian (`GET /api/companies/{MER}/approvals`) and approve it.
- **Do (Go #2):** `POST /api/handshake-demo/go`.
  - **Expect:** `mandate` step = done with a real `ledgerId`+`blockHeight` in its `evidence`; pauses at `accept` = **waiting_approval** (Trellis).
  - **Must NOT see:** the mandate step blocked/errored; skipping the accept gate.
- **Do (approve 2):** find the pending `mandate_acceptance` approval in Trellis and approve it.
- **Do (Go #3):** `POST /api/handshake-demo/go`.
  - **Expect (PASS):** the final step `transact` = done with a real `ledgerId`+`blockHeight` in evidence, and the top-level `done:true`.
  - **Must NOT see:** `transact` blocked; `done:false` after both approvals; a denial reason on the transact step.
- **Idempotency check:** call `POST /api/handshake-demo/go` a 4th time. **Expect:** it still returns `done:true` with all steps done (does NOT create a second mandate or a duplicate transaction, and does NOT error). If a 4th call re-anchors a new mandate or throws, that's a bug.

### TC-10 — Keyless verification of a real receipt (the trust claim)
The whole point is a receipt anyone can verify without trusting either side.
- **Do:** take the `ledgerId` and `blockHeight` from TC-5's (or TC-9's) anchored receipt. Call the public gateway directly (no app auth):
  ```
  curl -sS -X POST https://mcp.clockchain.network/mcp \
    -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
    -H "x-api-key: $(grep CLOCKCHAIN_MCP_KEY /Volumes/home/Projects_Hosted/ad/agentdash/server/.env | cut -d= -f2)" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"verify_cross_party","arguments":{"ledger_id":"<LEDGER>","block_height":<BLOCK>}}}'
  ```
- **Expect (PASS):** the response's inner text JSON shows `"keyless":true` and `"verifiedAgainst":"on-chain block"` with a real `anchoredHash`.
- **Must NOT see:** an error, or `keyless:false`. (If the gateway is transiently down, retry twice before failing; a gateway outage is an environment note, not an app bug.)

### TC-11 — UI: the Mandates tab renders live state
- **Where (browser):** `http://127.0.0.1:3100/MER/agents/{an agent id that is a grantee}/mandates` — use `QAGrantee` from TC-4, or `Vega2` (id `c0c32882-70aa-4b8d-beae-c0d74a8074aa`) which already has anchored mandates.
- **Do:** load the page (the URL uses the company **prefix** `MER`, not the id). Click the **Mandates** tab if not already on it.
- **Expect (PASS):**
  - A "Grant a mandate" form with fields: Grantor (dropdown), Spend cap (USD), Allowed actions (comma-separated), Expires (date), and a coral "Grant mandate" button.
  - A list of that agent's mandates, each showing grantor→grantee, the scope actions, the cap (e.g. `$1,000.00`), an expiry date, a `status` badge, and — for anchored ones — an **`Anchored · block <N>`** badge.
  - An "Attested actions" section listing any receipts with an `Anchored · block <N>` badge (green/secondary) for successes and a `Denied — <reason>` badge for denials.
- **Must NOT see (FAIL):**
  - The tab redirecting you back to `/dashboard` (the tab-routing bug — **P1** if it recurs).
  - An `Anchored` badge on a row whose `receiptStatus` is `pending`/`denied` (dishonest badge — **P1**).
  - Raw JSON dumped on screen, a blank white page, or a React error overlay.
- **Take a screenshot** as evidence for the report.

### TC-12 — UI: bounce-back approvals render in the inbox (known-partial)
- **Where (browser):** `http://127.0.0.1:3100/MER/approvals/pending`.
- **Do:** trigger a bounce-back first (TC-6 do-a) so there's a `mandate_violation` approval, then load the inbox.
- **Expect (PASS):** a `mandate_violation` approval card renders **human-readably** — showing the action, the reason (e.g. "outside the mandate's scope"), the counterparty, and an "Approve to resume the agent" line. NOT raw JSON.
- **KNOWN LIMITATION — do NOT file as a bug:** the two NEW orchestrator approval types, **`clockchain_onboarding`** and **`mandate_acceptance`**, do NOT have custom render cases yet — they will render as generic/raw JSON in the inbox. This is a documented follow-up, not a defect. Only file a bug if **`mandate_violation`** (which DOES have a render case) shows raw JSON.

---

## Known limitations — SKIP these, do NOT file bugs for them
1. `clockchain_onboarding` and `mandate_acceptance` approvals render as raw JSON in the inbox (custom UI cases are a pending follow-up). *(TC-12 covers this.)*
2. No "Go button" page in the UI yet — the orchestrator is API-only. Test it via `POST /api/handshake-demo/go` (TC-9), not a UI button.
3. No incoming-mandates UI view for Trellis yet — test cross-company visibility via the API (TC-8).
4. Testnet is single-validator/degraded: `consensusTime` is null and receipts say `single-validator-testnet`. Real anchors, no court-grade claim. Expected.
5. The agent is "scripted-real," not an autonomous LLM — the orchestrator drives the steps. Do not file "the agent isn't reasoning on its own."
6. x402 money movement is simulated (Clockchain attests, never moves funds). Expected.

---

## BUG-FILING PROTOCOL (fully automated)

For **every** test case that FAILS (an "Expect" missed or a "Must NOT see" observed), file a GitHub issue immediately, then continue the suite (do not halt except on TC-1 P0). Use `gh`:

```
gh issue create --repo thetangstr/agentdash \
  --title "[handshake-demo QA] <TC-id>: <one-line symptom>" \
  --label bug \
  --body "<body per template below>"
```

If the `bug` label doesn't exist, drop `--label bug` and retry. Body template (fill every section):

```
## Test case
<TC-id and title, e.g. TC-5 — Agent acts in-scope → REAL attested receipt>

## Severity
<P0 blocker / P1 major / P2 minor> — <one line why>

## Steps to reproduce
1. <exact request or UI action>
2. ...
(Include the exact curl command or the UI URL + clicks.)

## Expected
<the "Expect (PASS)" criterion that was violated>

## Actual
<what actually happened — paste the exact response body / status code / screenshot filename>

## Evidence
<raw response JSON, HTTP status, and/or screenshot path>

## Environment
- App: http://127.0.0.1:3100 (local_trusted)
- Commit: <run `git -C /Volumes/home/Projects_Hosted/ad/agentdash rev-parse --short HEAD` and paste>
- Clockchain: mcp.clockchain.network testnet (degraded pool)
```

**Severity guide:** a security/authz bypass (out-of-scope or over-cap action authorized; an agent using a mandate not granted to it; wrong-company accept succeeding) = **P0**. A dishonest state (an unconfirmed/denied receipt shown as "anchored"; resume-on-approve not firing; cross-company visibility broken) = **P1**. Cosmetic/wording = **P2**.

**Dedup:** before filing, `gh issue list --repo thetangstr/agentdash --search "[handshake-demo QA] <TC-id>"` — if an open issue for that TC already exists, add a comment instead of a duplicate.

## Do NOT file bugs for
- Anything in the "Known limitations" list above.
- Transient gateway timeouts (retry twice first; if still failing, note as an environment issue in the final report, not a GitHub issue).
- The `/mandated-actions` route returning 400 "granteeAgentId is required" when called as a board actor (TC-7) — that's the authz design.

## FINAL REPORT (always produce, even if all pass)
End by printing:
1. A **results table**: every TC-id → PASS / FAIL / N/A / SKIP, with a one-line note.
2. A **bug list**: every issue you filed, with its GitHub issue number + URL + severity.
3. A **verdict**: `SHIP` (all critical cases pass, only P2/known-limitation gaps) or `HOLD` (any P0/P1 failed), with a one-sentence rationale.
4. The **commit SHA** tested.

Begin now with TC-1. Run all cases in order. Be thorough, be exact, cite real response bodies as evidence.
