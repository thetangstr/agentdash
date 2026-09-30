# Ross report outcome verification

Bounded goal: independently inspect whether the exact lead-report revision promised by its refresh commitment was published and consumed by a succeeded Ross run. Preserve the distinction between this historical check, the truth of the report's business claims, artifact approval and overall operational completion.

Criteria version1:

1. Authenticate the configured Ross actor, company/project and visible parent issue; select an existing resolved reported-delivery commitment. Use API metadata for lead authorship, exact revision/document/issue/key, number, body and publication time.
2. Validate the consuming run's company, Ross actor, visible task, succeeded status and exact full Hermes session ID. Require an actual Ross-authored answer comment with matching run ID and body equal to the run result.
3. Acquire the existing cooperative private writer lock for inspection. Require exact private scope/provenance, prior writer/group terminal, rollback mode and no recovery sidecars. Read only the selected session and actual run interval, with message/byte limits. Preserve owner metadata and close SQLite before releasing the lock. Never open a live writer's ledger or import Hermes/provider modules.
4. Require a real issued tool call linked to the actual tool row, scoped issue arguments and response, exact delivered revision/body/API author, and observation after publication within the run. Consumption must have been fresh within the existing one-hour report limit. Text claiming a read, a matching standalone artifact checksum, approval or task status is insufficient.
5. Recollect and recheck current source authority after ledger inspection. Refuse changed sources without retry. Return a narrow `lead-report-publication-consumed` check with source URLs, body/ledger hashes, message/run/comment IDs and timestamps; always preserve `businessOutcomeVerified:false` and `reportClaimsVerified:false`.
6. Record the computed inspection through the existing versioned issue-document API as a Codex/operator check. Expose its API-derived author/revision/freshness and untrusted body over the same scoped read tool. This read does not itself rerun the private inspector or promote a broad verified field. A lead's body cannot claim operator authorship or authority.

Source ownership: `scripts/ross/` and this dated plan only; no API/schema/generic prompt/installed adapter changes. Tests cover scope/run/session forgery, altered answers/content, absent/unlinked tool reads, publication/freshness bounds, real flock/SQLite/subprocess/HTTP, access revocation and source change. No provider run is needed to perform the check.

Actual evidence: the owner CLI authenticated real sources and inspected terminal private session `<session>`; tool message18 consumed lead report revision <revision> during run <run>. The earlier manual transcript hash also matches its published work-product summary, establishing historical artifact integrity only. Inspection receipt (operator-private evidence).

First-company business task and the challenged verification-plan remain open. Continuous reporting, portfolio/caller scope, assistant access and private hosting/device/voice retain separate acceptance requirements. Existing services, launch work, schedules, Tailscale and protected evaluations remain unchanged.

The reviewed memory guard preflights count and byte size inside the read snapshot before fetching message bodies, using [SQLite octet_length](https://www.sqlite.org/lang_corefunc.html#octet_length); an actual oversized-row allocation regression passes. Independent review approved the fix and raw document transport with zero remaining issues.

Actual operator publication created document <document>, revision <revision>. Authenticated real MCP readback matched its exact body/revision and operator attribution, returned `independentlyRechecked:false`, and preserved two commitment batches/12 sources with both commitments unverified. No provider request was made for this check/publication/readback; GLM consumption of the new operator record is not yet evaluated. Revalidated inspection (operator-private evidence), publication readback (operator-private evidence), actual MCP receipt (operator-private evidence).

Validation: 125 Node tests, 8 scoped Vitest tests pass; 2 optional startup probes skipped. Syntax, scoped module validation and installed-source probes pass. No full repository build/typecheck or browser/voice check; this is a local pilot checkpoint, not production or PR-ready completion.
