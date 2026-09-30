# Ross chosen-assistant authentication acceptance

Goal: prove the real authentication and authorization protocol needed to expose Ross evidence through a user-selected personal assistant. Ross remains the executive OS, AgentDash the governed system of record, and Monica or another assistant the conversational client. This phase does not redefine the full operational goal as passing a fixture test.

Run from the prepared Ross checkout with existing dependencies:

```sh
node scripts/ross/run-assistant-auth-e2e.mjs
```

The dedicated runner passes a curated environment to both the fixed system OpenSSL executable and the Vitest child. It generates a fresh test secret and certificate, trusts only that additional certificate through NODE_EXTRA_CA_CERTS, fixes PATH to /usr/bin:/bin, and excludes live credentials, DATABASE_URL, SSO/email/provider/edge/claim settings. PAPERCLIP_HOME and caches are inside its owned temporary directory. The local Mac test uses existing workspace dependency links, including DB/shared dependencies; no shared build or install runs.

The test uses the existing embedded PostgreSQL test helper for a fresh database on a nonreserved port, and an HTTPS listener bound to 127.0.0.1 on port0. It mounts production Better Auth, actor resolution, OAuth, MCP and source routes, with the Ross candidate MCP package aliased to its current source. It does not import full application startup. The health URL-context response is a minimal fixture; source and authorization responses come from production routes. All company, membership, project and document records are explicitly synthetic test fixtures, not real company activity or executed GLM work. The test's fetch guard refuses URLs outside its listener.

Document bodies remain untrusted source text, including a fixture verification claim. This candidate reader does not resolve commitment/run/acknowledgment references or independently verify document contents. The auth test cannot establish durable commitment closure.

Acceptance sequence:

1. Real email signup and subsequent sign-in produce a session cookie; the actual session endpoint and actor resolver identify that test user. No inserted session or mocked resolver substitutes for authentication.
2. SDK resource/issuer discovery and dynamic client registration precede S256 PKCE authorization. An unsigned consent read and untrusted-origin consent mutation fail; the authenticated test user consents to read-only access for one company.
3. Token exchange and SDK Streamable HTTP initialization expose read tools, with work tools absent. whoami reports the consenting test user and selected company.
4. get_work_item returns actual service-created document/revision metadata for lead-report, ross-commitments and operator-authored ross-outcome-checks. Current lead attribution, source URLs and explicit independentlyRechecked:false/businessOutcomeVerified:false are preserved.
5. Raw issue/document and consent endpoints refuse the genuine assistant bearer. Restricted projects without the member's explicit access and a second company remain inaccessible, even though the human belongs to both companies. Removing project access invalidates further evidence reads.
6. Session-authenticated grant revocation makes the existing MCP token return401 and the SDK refresh attempt fail. The assistant cannot mint itself another grant.
7. SDK connections, listener, DB client and owned embedded database are cleaned up; runner removes its temporary home, certificate and cache. Database cleanup runs in finally even if preceding shutdown fails.

Fresh evidence: private checkpoint (operator-private evidence). Independent review found an ambient environment inheritance in the initial certificate subprocess; the final runner passes the curated environment to both children and uses the fixed executable. The corrected end-to-end sequence passes. Syntax and diff checks pass. LSP transport is unavailable, and repository-wide typecheck/build are not claimed; the inherited droid-local reference remains absent.

This proves real protocol behavior for a simulated identity on an isolated candidate. It does not prove the owner's real sign-in/consent, Muse/ChatGPT/Monica integration, running-package replacement, private hosting, voice, continuous reporting, portfolio coverage or independent business outcomes. The preceding live acknowledgment required an explicitly attributed operator encoding repair; its original model run remains failed. No deployment, push, shared restart/migration, provider request, live grant, schedule, Tailscale or shipping-owned auth/human-control edit occurs in this lane. Next: consume the test evidence in the genuine lead/Ross review loop and prove the user-facing connection using actual identity and the reviewed installation boundary.
