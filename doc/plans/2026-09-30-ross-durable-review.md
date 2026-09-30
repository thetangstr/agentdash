# Ross durable review implementation plan

> **For agentic workers:** Execute the bounded tasks below with test-first changes and independent review; preserve other workers' files.

**Goal:** A chosen assistant can retrieve a complete, attributed Ross recommendation after a governed run, rather than relying on truncated comment previews.

**Architecture:** Reuse AgentDash issue documents and the existing assistant `get_work_item.rossEvidence` projection. The runtime publishes a fixed `ross-review` document after checking the actual run, checkout, model receipt and caller scope; the model receives no write tool. Assistant reads preserve source attribution, revision, freshness and verification limits.

**Tech stack:** Existing Node publisher, AgentDash document API, MCP projection, isolated real-auth/OAuth test. No new dependencies or schema/routes.

**Spec:** the operator-private Ross handoff and operating model under the supplied F6 evaluation directory; later user direction makes the personal assistant replaceable.

## Constraints

- Own only isolated Ross worktree files assigned below. No push, package installation, shared restart, migration, Tailscale or schedule changes.
- Existing company/project/actor checks, atomic checkout, budget/quota gates and activity logging remain authoritative.
- Persist the exact decoded model answer, actual run/session references and exact model/provider as source content. A document is neither artifact approval nor business verification.
- Reserve one private intent per actual run before PUT; preserve ambiguous attempts, use CAS, reject changed readback and never retry an ambiguous write.
- JSON must survive the API's existing newline normalization via the tested API-safe encoder.
- Current assistant grants, project access/revocation and redaction stay unchanged. Only advertised named documents are read.

## Task 1: runtime-owned Ross review publication

Files: `scripts/ross/ross-review.mjs`, `scripts/ross/ross-review.test.mjs`; root owns `scripts/ross/governed-cli.mjs` integration.

Interface: `publishGovernedRossReview({binding,invocation,receipt,request,workspace})` returns `{issueId,documentId,revisionId,revisionNumber,bodySha256,runId,source}`. `request(path,body?,method?)` is the existing authenticated request. Publish fixed key `ross-review`, JSON `{schemaVersion:1,kind:'ross-review',answer,runId,sessionId,model:'glm-5.3-flash',provider:'zai',outcomeVerification:'not-performed'}`. No model-chosen URL, key or identity.

- [x] Write failing tests for absent-document creation, CAS update, exact decoded answer including newlines/backslashes, actual actor/run/checkout/model checks, duplicate reservation, ambiguous PUT and altered readback.
- [x] Run `node --test scripts/ross/ross-review.test.mjs` and inspect the expected missing-feature failure.
- [x] Implement the existing publisher pattern with the existing missing-role Ross default (explicit non-Ross roles denied) and current authenticated project visibility. Only a sanitized 404 creates revision1 with baseRevisionId:null.
- [x] Wire the publisher after a successful Ross receipt in the governed CLI; lead report/ack paths remain separate.
- [x] Run targeted publisher tests, then the complete Node pilot suite.

## Task 2: personal-assistant source projection

Files: `packages/mcp-server/src/assistant/ross-evidence.ts`, its existing tests, `packages/mcp-server/src/playbook.ts`.

Interface: advertise/read `ross-review` alongside the existing three source keys. The JSON answer/run references remain redacted untrusted source content. Do not infer Ross authority or model provenance from body fields alone; metadata retains actual API author/revision/time. Existing 6000-character truncation must be explicit.

- [x] Add a failing current-source test that a full recommendation beyond comment-preview limits is returned with attribution; include redaction/revision-access-change coverage.
- [x] Add the named key to the existing projection and explain source limits in the existing playbook.
- [x] Run package tests/typecheck/build; record no production installation.

## Task 3: integrated protocol and actual-run acceptance

Root owns `scripts/ross/assistant-auth.e2e.ts`, README and existing prompt named-block updates. The CEO/CoS template paths do not exist in this checkout; preserve that explicit limitation rather than fabricate templates.

- [x] Extend the real isolated auth test with a versioned Ross review and verify full decoded answer/source metadata through authenticated MCP, then project/company denial and revocation. Synthetic identity/data are labelled separately from actual GLM runs.
- [x] Perform independent source review and scoped verification. Check production request normalization in the real document route, not only publisher doubles.
- [x] Run one authorized supervised GLM Ross follow-up; verify its exact runtime-owned document, run attribution, durable revision and source readback, then pause the owned pilot.
- [x] Leave an evidence-linked checkpoint, clean local Lore commit and shipping coordination note. Full client/continuous/portfolio/hosting acceptance remains open.

## Acceptance checkpoint

Runtime publication and candidate source retrieval passed on actual GLM/Z.AI runs <run> and <id>. The latest exact answer was published via CAS as Ross review revision2 <revision> and returned by candidate MCP transport. Both runs used fresh sessions; these do not establish new restart acceptance. Source transport used Ross's scoped agent identity, not human assistant consent.

Independent comparison keeps the general reconciliation guidance but records a medium reasoning gap: Ross still requests a recorded hash check again. No claim that this instruction fixed recommendation quality. Broader operational acceptance, actual client identity/scope, portfolio coverage, continuous freshness and private hosting remain open. Shipping receipt remains unconfirmed.

Evidence: checkpoint (operator-private evidence), source readback, actual run proofs and comparison review in that directory.
