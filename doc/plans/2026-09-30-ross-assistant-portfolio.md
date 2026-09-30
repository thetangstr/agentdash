# Ross private assistant portfolio collection

Goal: prepare company-separated sources for Ross portfolio reasoning by composing independent assistant grants belonging to the same consenting user. The live second-company pilot is not activated before first-company client acceptance. This phase uses an isolated HTTPS/database integration with synthetic identities and companies.

Use existing authenticated MCP clients and the nine read tools, rather than bypassing assistant visibility through the digest service or pooling tenant keys. Each grant remains pinned to one company. Add the actual company UUID to whoami metadata; require matching expected user/company identities before and after fixed work-item reads. Fail closed on identity mismatch; discard collected company data if post-read authorization fails. Keep source freshness, attribution, incomplete/refused status and no-outcome-verification flags. No synthesis persistence, API/schema/auth policy changes, new tool, runtime or live activation.

Ownership: root owns whoami metadata/test, real-auth e2e and docs; publisher executor owns only scripts/ross/assistant-portfolio.mjs and its Node tests. Preserve unrelated edits.

Acceptance: red/green identity metadata test; real two independent OAuth/DCR/PKCE grants for one signed-in test user/client; A token denies B and B token denies A; private collection contains separately attributed sources; revoke A and keep B usable; partial failed-company data never returned; bounds and identity/scope overrides denied in unit tests. Run Node pilot suite, MCP tests/typecheck/build, isolated auth runner and independent review. Validate per-call cancellation and rejection of malformed timestamps; no wedged call may retain partial company data.

Limits: this proves isolated protocol/source composition, not real human client consent, GLM multi-company synthesis, continuous lead reporting, hosting, voice, live deployment or business completion. Do not put B sources in A's existing Hermes session, company documents or memory. The portfolio model context will need a separate owner-private runtime.

Verified checkpoint: isolated OAuth/MCP e2e 1/1, Node pilot suite 157/157, MCP package 212/212 plus typecheck/build; final independent review has no blockers after cancellable deadline and strict source-time checks. Evidence: operator-private evidence. This is bounded local preparation, not full Ross operational completion.
