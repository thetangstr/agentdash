# How you (Codex) should start taking this over

You are picking up active work on AgentDash, a CoS-led multi-human AI workspace built on Paperclip. Two pull requests are in flight; the human owner asked another agent (Claude) to "review and merge" the first one, then asked me to package the handoff so you can take over from here. Read this whole file before touching anything.

---

## 1. Repo + working tree

- Repo: `github.com/thetangstr/agentdash`
- Base branch: **`main`** during the v2 rebuild. Not `agentdash-main` yet — see `doc/UPSTREAM-POLICY.md`.
- Tooling: **pnpm** (NOT npm/yarn), Node 20, Drizzle ORM, Express 5 + WebSocket server, React 19 + Vite UI, Vitest, Playwright.
- Workspaces: `server/`, `ui/`, `cli/`, `packages/*`. The new attestation package lives at `packages/attestation/`.

Read these three files before doing anything else, in this order:

1. **`CLAUDE.md`** at repo root — project conventions, MAW slash-command workflow, MANDATORY regression-testing rules. The "Mandatory regression testing before handing off" section is non-negotiable: `pnpm -r typecheck && pnpm test:run && pnpm build` must pass; UI changes need Playwright runs; you MUST report results before any handoff to the human.
2. **`doc/UPSTREAM-POLICY.md`** — do NOT bulk-merge `upstream/paperclip`. Reference-only.
3. **`docs/superpowers/specs/2026-05-13-delegation-and-attestation-design.md`** — the v1 attestation spec already implemented.

---

## 2. What's in flight

Two pull requests:

### PR #289 — feat(attestation): v1 audit trail + Clockchain adapter

- Branch: **`claude/loving-ellis-e2f1b5`**
- Status at handoff: rebased onto latest `main`, gates re-running, ready to force-push-with-lease and merge once green.
- The diff adds:
  - `packages/attestation/` — new package: `AnchorAdapter` interface + Clockchain + Noop implementations + manifest hasher
  - `packages/db/src/migrations/0083_trail_anchors.sql` — was `0082` before the rebase; renamed because `main` shipped `0082_heal_attempts_and_events`
  - `packages/db/src/schema/trail_anchors.ts`
  - `server/src/services/attestation.ts` — the periodic anchoring service + Drizzle-backed `AttestationStore`
  - `server/src/index.ts` hunk wiring a `setInterval` cron behind `AGENTDASH_ATTESTATION_ENABLED=true`
  - `server/src/__tests__/attestation.test.ts` — in-memory fake store, end-to-end chain-of-custody coverage
- Feature-flag gating is the entire safety contract. Verify before merging:

  ```bash
  grep -nE "AGENTDASH_ATTESTATION|attestationService" \
    server/src/index.ts server/src/services/index.ts
  ```

  The cron block is the ONLY place runtime code runs. The migration is additive (`CREATE TABLE`), so landing the schema with the flag off is safe.

### PR #338 — docs(attestation): spec for v2a (agent identity + delegation certs)

- Branch: **`claude/attestation-v2a-spec`**
- Docs only, no code, no migrations.
- One file: `docs/superpowers/specs/2026-05-14-attestation-v2a-agent-identity-and-delegation-design.md`
- Describes the next phase: per-agent Ed25519 keypairs, signed action envelopes on `activity_log`, `delegations` table, CoS sub-delegation, end-to-end verifier.
- Estimated effort: **~16 engineer-days**.

---

## 3. Immediate task

The human owner asked: *"review and merge."* Do this in order:

1. `cd` into the worktree at `.claude/worktrees/loving-ellis-e2f1b5` (or check out `claude/loving-ellis-e2f1b5` in a clean worktree).
2. Verify the three gates pass on the rebased branch:

   ```bash
   pnpm install --frozen-lockfile
   pnpm -r typecheck
   pnpm test:run
   pnpm build
   ```

   Three pre-existing UI test failures in `ui/src/pages/CompanyInbox.test.tsx` (jsdom/undici relative-URL parse) were resolved by recent main commits (#324, #329); if they reappear, confirm by `git diff HEAD -- ui/` that you didn't touch UI.

3. Re-confirm the feature flag wraps all runtime code:

   ```bash
   grep -rn "attestationService\|createAttestationStore\|trailAnchors" \
     server/src ui/src --include="*.ts" --include="*.tsx" \
     | grep -v __tests__ | grep -v "\.test\."
   ```

   Everything outside `index.ts:1012`'s `if (process.env.AGENTDASH_ATTESTATION_ENABLED === "true")` block must be exports/types only.

4. Force-push-with-lease: `git push --force-with-lease origin claude/loving-ellis-e2f1b5`
5. Wait for CI to land. The repo's **30-day autonomous ship window** is active through **2026-06-02**, granted 2026-05-03 — merge is authorized once CI passes without a human verification gate. Memory file: `~/.claude/projects/-Users-Kailor-Documents-Projects-agentdash/memory/feedback_autonomous_ship_window.md`
6. Merge PR #289 once green, then merge PR #338 (docs-only, no CI concerns).

---

## 4. The live API key (sensitive)

The human pasted a Clockchain dev API key earlier: `ecae2650dec34ae7924649c9b82cb1cb`. It was used inline to validate the live API; **never committed** to any file. Treat it as compromised-by-pasting and recommend rotation after testing. Do **NOT** add it to any committed file. For dev use, drop it in a gitignored `.env` at repo root as `CLOCKCHAIN_API_KEY=...`.

---

## 5. Context for judgment calls

The product question hanging over this work is: *"Is this attestation effort worth shipping?"*

The `/last30days` research run from 2026-05-14 returned strong signal that the answer is yes:

- Palo Alto Networks completed its **$25B CyberArk acquisition** in Feb 2026 and launched **Idira** on May 12 for AI agent identity governance.
- **Infoblox + GoDaddy** announced **DNS-AID** (Infoblox, DNS-based agent discovery) and **Agent Name Service** (GoDaddy, DNS + PKI) on May 14 — submitted to IETF as `draft-narajala-ans-00`.
- `r/AI_Agents` had two viral threads (46 + 14 comments) in May about *"the moment output becomes authority"* — the agent-action-provenance problem we solve.
- **EU AI Act** audit-trail requirement effective **2026-08-02** — regulatory tailwind.
- `nono.sh` independently published the exact same architecture we shipped (append-only Merkle tree with pre/post-root checksums).

### Standards stack picture (May 2026)

| Layer | Leader | Status |
|---|---|---|
| Handshake / communication | **A2A** (Linux Foundation, 150+ orgs incl. AWS, Cisco, Google, IBM, Microsoft, Salesforce, SAP, ServiceNow) | **Runaway leader.** Anthropic is not a member. |
| Tool access | **MCP** (Anthropic) — OAuth 2.1 + SEP-1289 JWT | **De facto** |
| Naming / discovery | **ANS** (IETF `draft-narajala-ans-00`) | **Emerging consensus** |
| Cryptographic identity | **W3C DIDs** + **AIP** (IETF `draft-singla-agent-identity-protocol-00`) + **ERC-8004** (Ethereum-native, ~130k agents projected by year-end) | **Converging** |
| Audit / anchor (the lane we're in) | **NO WINNER.** Competitors: OpenTimestamps (Bitcoin, free, mature), Sigstore/Rekor (CNCF, free), Clockchain (testnet, token-burn), VeritasChain VCP/VAP, AWS QLDB | **Open** |

### Clockchain-specific read

Useful as a launch-partner anchor adapter, **NOT a standard**. Speed (1 block/sec) is their marketing wedge, but our batched periodic anchoring (5-min cadence, reviewed months later) doesn't benefit. Recommend shipping an **OpenTimestamps adapter** alongside Clockchain before the first enterprise customer review — removes single-vendor risk.

---

## 6. Next work after merge

The `/workon` MAW pipeline is the path to start v2a (the spec in PR #338). Create a Linear issue, then:

```
/workon AGE-<id>
```

PM agent decomposes, Builder implements, Tester runs E2E + code review, TPM merges. See `.claude/commands/*.md` for each agent's contract.

### Priorities, in order

1. **Add OpenTimestamps adapter alongside Clockchain** (half-day; removes single-vendor risk before any prod flip).
2. **Implement v2a spec — per-agent Ed25519 keypair + signed action envelopes** (Component 1 + 2 from the spec; ~5 engineer-days).
3. **Implement `delegations` table + CoS sub-delegation issuance API** (Component 3; ~5 engineer-days; **no** boundary enforcement yet — that's v2b).
4. **Verifier function + `agentdash verify-trail` CLI**.

**Do NOT start v2b boundary enforcement** until v2a is in prod for at least a week — we need observability on signing performance before we make missing signatures a hard 403.

---

## 7. Things to ask the human before acting

- Whether to also ship the OpenTimestamps adapter as part of the v1 merge or as a follow-up.
- Whether to rotate the Clockchain dev key (recommended — was pasted in chat).
- Whether to start v2a implementation immediately after merge or wait for partnership credit / demand validation.
- Whether to enable the flag in staging now that gates are green.

---

## 8. Things you should NOT do

- Do **NOT** force-push to `main`.
- Do **NOT** skip pre-commit hooks (`--no-verify`) or signing.
- Do **NOT** bulk-merge `upstream/paperclip`.
- Do **NOT** commit the Clockchain API key.
- Do **NOT** add UI changes without running Playwright E2E specs (`tests/e2e/*.spec.ts`).
- Do **NOT** mark v2a complete until end-to-end verification round-trip works against a live Clockchain testnet key.
