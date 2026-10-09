# Per-steward document access: Microsoft 365

2026-10-08 · **Plan, slice 1 in progress** · Line numbers are as of `5b50db7df`; re-check before editing.

**Recommendation.** Give an agent read access to exactly its current steward's documents by resolving document-provider connections *only* through the live stewardship row, never through agent-owned or workspace-visible rows. Replace the dead OBO connect path with a standard authorization-code + PKCE flow that stores a refresh token, so access survives the hour. Reads are server-side, GET-only, size-capped, text-extracted and framed as untrusted. Writes exist only as `connector_send` approvals executed by a separate service after the steward approves, and only as *new* files in v1. Seven slices to build (1, 2, 3, 5, 6b, 6, 7; slice 4 is deferred), each shippable alone, all behind one per-company feature flag. Do not build the "allow the OneDrive folder in the sandbox" shortcut (see Threat model).

**Decisions recorded 2026-10-08 (owner).**
- **D1: override.** Document access is in scope; `2026-09-24-mvl-1.0.md:179` and the MK design spec `:75` are superseded by this plan. Both are annotated in the PR that adds this plan.
- **D3: Google Drive is deferred.** Slice 4 is **not built**. Every other slice is Microsoft-only. The `GMAIL_SCOPE_SEND` bug is still real; fix it as a separate one-line PR, not inside this plan.
- **D5: yes.** v1 writes are new files in the steward's own OneDrive only. SharePoint-site uploads are deferred.
- **D6: run logs are a hard gate (new slice 6b below).** Verified: `GET /heartbeat-runs/:runId/events` and `/log` (`server/src/routes/agents.ts:5173-5230`) check only `assertCompanyAccess`, so any company member reads any run; serve-time redaction covers secrets only; `heartbeat_run_events` has no retention. The flag must not go on for a company until slice 6b ships.
- **Prerequisite (not in the original plan): a trusted HTTPS origin.** Entra accepts only HTTPS redirect URIs other than localhost (per Microsoft's redirect-URI rules; **re-verify against current docs**). An instance served over plain HTTP or a bare IP address cannot complete slice 2 until it has a DNS name with a certificate the browser trusts.

**Scope.** `doc/plans/2026-09-24-mvl-1.0.md:179` and `docs/superpowers/specs/2026-07-28-agentdash-mk-design.md:75` placed SharePoint and Google Drive connectors out of scope. D1 supersedes both for Microsoft 365 document access only; Google Drive stays out of scope.

## What exists (verified by code read)

| Piece | Where | State |
|---|---|---|
| Entra OBO, read-only scopes pinned, write-scope refusal, per-principal cache | `server/src/services/entra-obo.ts:59-62, :74-79, :157-171, :181-316` | Requests no `offline_access` (`:234`) and the stored credential is the *user assertion* (`sharepoint-connector.ts:238-250`), itself an expiring access token. After ~1 h every exchange answers `assertion_rejected` and the row goes `error` (`:399-405`). **Verified by code read, not runtime.** Confirm on a deployed instance: `select status, updated_at from connections where provider='sharepoint'`; `status='error'` within ~1 h of connect, and no `refreshToken` key in `encryptedToken`. |
| SharePoint reads (site drive, list items, workbook ranges), GET hardcoded | `sharepoint-connector.ts:184-192, :525-820`; routes `routes/sharepoint-connector.ts:162-239`, profile-gated `:36-44` | No `/me/drive`, search, or `/content`. No UI; connect needs a raw `userAssertion` nobody can obtain (`:62-67`). |
| `resolveActingAs` | `server/src/services/connectors.ts:377-581` | Steward fallback `:466-473` runs only when `:434-438` admitted no agent-owned or `visibility: "workspace"` row, so a workspace row shadows the steward. `POST /companies/:id/connections` (`routes/connectors.ts:94-116`) accepts `workspace` (`validators/connector.ts:33`). |
| Gmail OAuth (template) | `gmail-connector.ts:78-82, :210-295`; `routes/gmail.ts:56-175` | Auth-code with `access_type: offline`, refresh persisted. Bug: `GMAIL_SCOPE_SEND` (`gmail-connector.ts:20`) is `https://mail.google.com/auth/gmail.send`; Google documents `https://www.googleapis.com/auth/gmail.send` (verified 2026-10-08). Callback leaves the pending state row behind (`routes/gmail.ts:146-163`). |
| Approval-gated writes | `connector-send-execution.ts:218-480`; `validators/approval.ts:20, :79`; HubSpot executor `:403` | One provider. Executor re-resolves at apply time. |
| Token store | `connections.encryptedToken` (`packages/db/src/schema/connections.ts:46`); `TokenPayload.refreshToken` (`connectors.ts:31-32`); `storeOAuthState/consumeOAuthState` (`:610-647`) | Sufficient; no new columns. |
| Feature flags | `services/feature-flags.ts:24-60`; keys `packages/shared/src/constants.ts:1288-1290` | Per-company table exists. |
| Sandbox | `agent-sandbox-config.ts:155-160` → `configureDefaultLocalSandbox` (`packages/adapter-utils/src/server-utils.ts:109`); `seatbelt.ts:315-340` | One process-wide spec for every run. |
| Run logs | `heartbeat_run_events`, served at `routes/agents.ts:5173`; `services/run-log-redaction.ts:81-112` redacts known secrets only | Document text returned to an agent lands in its transcript. |
| Skills | repo `skills/` via `server-utils.ts:176-179` | Add one skill. |

Public facts (Microsoft Learn, read 2026-10-08): delegated `Files.Read.All` and `Sites.Read.All` are `AdminConsentRequired: No`; a tenant can still disable user consent, which makes admin consent required in practice. OBO returns a refresh token only with `offline_access`, and the assertion must have `aud` = our own client id.

## Decisions encoded for the executor

- **Provider keys.** v1 is Microsoft only: `microsoft` (already in `CONNECTION_PROVIDERS`, `constants.ts:1185`) for OneDrive + SharePoint via auth-code. If slice 4 is ever un-deferred, Drive gets a new key `google_drive`, not `google`: Gmail routes select on `google` (`routes/gmail.ts:38`) and its scope presets would collide. The legacy `sharepoint` row and `entra-obo.ts` stay untouched and keep working for anyone who has one; they are folded into the steward-only rule but not migrated.
- **Auth-code + PKCE, not OBO.** OBO needs a front-end that acquires a token with `aud` = our API (MSAL in the SPA, an exposed API scope, known-client wiring) and *still* needs `offline_access` to outlive an hour. Auth-code gives the same delegated semantics (Graph answers with what the steward can see) with one app registration, one redirect, and a refresh token. Confidential client with `ENTRA_CLIENT_SECRET` (already configured).
- **One connection row per provider per owner, scope tier chosen at connect** (`read` or `read_propose`). Upgrading means reconnecting. Two rows were rejected: `resolveActingAs` returns one row per provider and the stewardship rule must stay "one steward, one row".
- **Reads are structural GET.** New read services copy the `graphGet` pattern (`sharepoint-connector.ts:184-192`) and get the same source-scan test (`agentdash-mk-sharepoint-obo.test.ts:123-135`). Writes live in separate files that are imported only by the executor.
- **Gate = feature flag `document_access_enabled`, not product profile.** Resolution tightening (slice 1) applies to every company; routes 404 without the flag. Unlike the SharePoint routes there is no `agentdash_mk` check, so the owner can enable it on a default-profile company later. If D2 says "profile-gate too", add `requireProductProfile` next to the flag check.
- **v1 writes create new files only.** No overwrite, no delete, no in-place edit. "Propose edit" means: upload `<name> (proposed by <agent> <date>).docx` in the steward's own OneDrive (D5).

## Slices

Each slice: failing test first, then implementation, `pnpm --filter server test -- <file>`, typecheck, no new migration unless named. Tests follow `agentdash-mk-sharepoint-obo.test.ts` (embedded Postgres, mocked provider HTTP via a local server, `describeEmbeddedPostgres`).

### Slice 1: steward-only resolution for document providers (security)

Files: `connectors.ts:377-581`; `packages/shared/src/constants.ts` (add `DOCUMENT_PROVIDERS = ["sharepoint","microsoft"]`; `google_drive` joins only if slice 4 is ever un-deferred); `routes/connectors.ts:94-116`; `validators/connector.ts:28-35`.

1. In `resolveActingAs`, before `:434`, branch on `DOCUMENT_PROVIDERS.includes(provider)`: skip the agent-owned/workspace filter entirely; `usable` = rows where `ownerType === "user" && ownerId === activeStewardship.userId && visibility === "private" && encryptedToken !== null`. No stewardship → `no_connection`. For `actorType: "user"` keep the existing own-rows behaviour (a steward testing their own connection). Do **not** gate this on `policy` being non-null (the current `:466` gate is profile-coupled; document access is not).
2. In `routes/connectors.ts:94-116` and `connectors.create` refuse `visibility: "workspace"` for any document provider (422, message says why). Also refuse `ownerType: "agent"`.
3. Migration `packages/db/src/migrations/<next number>_document_connection_owner_uq.sql` (check the latest number at build time): partial unique index on `(company_id, owner_type, owner_id)` where `provider = 'microsoft' and revoked_at is null`, mirroring `connections.ts:68-70`. Also run the hubspot-style backfill check: fail the migration if duplicates exist.

Acceptance: a workspace-visible `microsoft` row owned by another user is **not** resolved for the agent; the agent resolves its steward's private row while the stewardship is active; ending the stewardship (`agent-stewardships.ts:242-280` path) makes the next resolve answer `no_connection` with no revocation; a second agent stewarded by someone else never resolves that steward's row; existing HubSpot/Gmail/Slack resolution tests unchanged (`agentdash-mk-provider-ceiling.test.ts` still green).

Do not touch: autonomy/sendIdentity resolution (`:518-581`), the ceiling filter (`:482-500`), legacy `sharepoint-connector.ts`.

### Slice 2: Microsoft connect from My Agent

Files: new `server/src/services/microsoft-graph-auth.ts`, new `server/src/routes/microsoft-documents.ts` (mount in `app.ts` next to `:559`), `app.ts`.

- Scopes requested: `openid profile offline_access User.Read Files.Read.All Sites.Read.All`; tier `read_propose` adds `Files.ReadWrite` (steward's own OneDrive; delegated, `AdminConsentRequired: No` per the reference). Do not request `Files.ReadWrite.All` or `Sites.ReadWrite.All` in v1 (D5).
- `POST /companies/:id/me/connections/microsoft/oauth/initiate {redirectUri, tier}` → `storeOAuthState` with `stateToken`, PKCE `codeVerifier` (`oauthState` column was built for this, `connections.ts:47`), `tier`; returns the `login.microsoftonline.com/{ENTRA_TENANT_ID}/oauth2/v2.0/authorize` URL. Board user only, bound to `req.actor.userId`; no `userId` body parameter (same rule as `routes/sharepoint-connector.ts:19-23`).
- `POST .../oauth/callback {code, state, redirectUri}` → consume state, exchange at `/oauth2/v2.0/token` with `code_verifier`, probe `GET /me`, then **update the pending row in place** (scopes, `encryptedToken` = {accessToken, refreshToken, expiresAt, scope}, `accountLabel` = UPN, `visibility: "private"` hard-forced). This also fixes the Gmail pattern of leaving a tokenless pending row.
- `tokenForConnection(connectionId)`: decrypt; refresh via `grant_type=refresh_token` within 60 s of expiry; persist via `connectors.refreshToken` (`connectors.ts:235`); return `{accessToken, grantedScopes}`, never the refresh token. Use `grantedWriteScopes` (`entra-obo.ts:77`) to *record* write capability; the write service (slice 5) decides, this does not refuse.
- `GET /me/connections/microsoft` health (id, account, scopes, status, tier, `lastError` derived from `status` + latest `connection.microsoft_*` activity row; no new column, D7), `POST .../revoke`.
- Env: existing `ENTRA_TENANT_ID/CLIENT_ID/CLIENT_SECRET`. Redirect URI for the operator's app registration: `https://<instance>/connect/microsoft/callback`.

Acceptance: callback stores a refresh token and never the code; token endpoint mocked; refresh path persists a new access token and a rotated refresh token; a callback with a mismatched `state` or reused state 400s and stores nothing; health route never returns token material (assert on the JSON string); flag off → 404 on every route.

Do not touch: `entra-obo.ts`, `sharepoint-connector.ts`, `routes/sharepoint-connector.ts`.

### Slice 3: Microsoft read tools

Files: new `server/src/services/microsoft-documents.ts` (read only), new `server/src/services/document-content.ts` (extraction + framing, provider-neutral), routes in `routes/microsoft-documents.ts` (agent-authenticated, `requireAgent` copied from `routes/sharepoint-connector.ts:52-60`).

- Graph calls, all GET: `/me/drive/root/children`, `/me/drive/root:/{path}:/children`, `/me/drive/search(q='…')`, `/sites?search=…`, `/sites/{id}/drive/search(q='…')`, `/me/drive/items/{id}` (metadata, `size`, `file.mimeType`), `/me/drive/items/{id}/content` (follow the 302 to the pre-authenticated URL; cap at `DOCUMENT_MAX_BYTES = 25 MB`, stream and abort past it). Shared-with-me: `/me/drive/sharedWithMe`.
- Extraction in `document-content.ts`: `.docx` → paragraph + table text; `.pptx` → per-slide text with slide numbers; `.xlsx` → refuse, point at the workbook-range route; other → metadata only, `content_unsupported`. Use `jszip` + `fast-xml-parser` (in `pnpm-lock.yaml`; add as direct `server` deps if not). Return at most `DOCUMENT_MAX_TEXT_CHARS = 60 000` per call with `offset`/`truncated`, so a 300-page contract is paged, not dumped into one turn.
- Framing: generalize `frameUntrustedSharepointText` (`sharepoint-connector.ts:100-111`) into `frameUntrustedDocumentText(provider, text)`; frame names, descriptions and body text, never ids, sizes, URLs, timestamps.
- Resolution through slice 1; rate budget and auth-failure breaker copied from `sharepoint-connector.ts:150-168, :330-347`; a 401 marks the row `error`.
- Workflow event per fetch inside a run carries item id and byte count, **never text or principal** (test pattern at `agentdash-mk-sharepoint-obo.test.ts:1145`).

Acceptance: the source-scan test proves no write verb in `microsoft-documents.ts`; a mocked 30 MB item is refused before download completes; docx/pptx fixtures extract expected text and arrive framed; a steward change mid-test flips the next read to `no_connection`; results contain no `accessToken` substring.

### Slice 4: Google Drive connect + read (DEFERRED by D3; do not build)

Files: new `services/google-drive-connector.ts`, `routes/google-drive.ts`; one-line fix at `gmail-connector.ts:20`.

- Copy `gmail-connector.ts:210-295` (OAuth URL with `access_type: offline`, `prompt: consent`, `exchangeCode`, `oauth2.on("tokens")` persistence). Provider `google_drive`; tier `read` = `https://www.googleapis.com/auth/drive.readonly`; tier `read_propose` adds `https://www.googleapis.com/auth/drive.file`. **Not `drive`** (full scope; restricted, needs Google verification for external apps). `drive.file` reaches only files the app created or the user picked, which is exactly enough for "create a proposal file"; it cannot edit the steward's existing docs in place, which v1 does not do anyway.
- Reads: `files.list` with `q` (`fullText contains`, `name contains`), `files.get(fields=…)`, `files.get(alt=media)` for binaries, `files.export(mimeType=text/plain)` for Docs/Slides and `application/vnd.openxmlformats…` when the caller asks for docx. Same caps, extraction and framing as slice 3 via `document-content.ts`.
- Fix `GMAIL_SCOPE_SEND` to `https://www.googleapis.com/auth/gmail.send` with a test asserting the constant equals the documented string.
- Deferred by D3; build only when a deployment needs Drive.

Acceptance: as slice 3, against a mocked Google token + Drive server; `drive.readonly` tier cannot create a file (executor refuses on scope, slice 5 test).

### Slice 5: propose-upload behind steward approval

Files: `validators/approval.ts:20` (`CONNECTOR_SEND_PROVIDERS` += `microsoft`; Microsoft only in v1), `:79-140` (per-provider payload shape), `connector-send-execution.ts:403` (dispatch by provider), new `services/microsoft-documents-write.ts` (the only file with PUT/POST to a provider; imported only by the executor), `routes/*-documents.ts` (`POST …/propose`, agent-authenticated, files the approval like `routes/hubspot-connector.ts:176`).

Payload: `{provider, operation: "upload_new", target: {driveId|folderId, path}, fileName, attachmentId, sourceItemId?, summary}`. The file body is an `issue_attachments` row the agent uploaded (`attach_file` exists in MCP), not inline base64; the executor streams it. `summary` is the steward-readable "what changed and why". `operation` is an enum with one member in v1; `update`/`delete` are rejected by `checkConnectorSendPayload` so an approved payload can never overwrite.

Executor: re-resolve via slice 1 at apply time (stewardship may have ended since filing → `recordRefusal` with a new reason `steward_changed`); require the write scope on the *current* grant (`Files.ReadWrite`), else refuse `write_scope_missing`; `classifyAction` marks `upload_new` as non-destructive but still `approval_required`; outcome row and activity log carry ids and digests only.

Acceptance: filing without the write tier is accepted as an approval but refused at execute with `write_scope_missing`; ending stewardship between approve and execute refuses with `steward_changed` and no provider call (assert the mock saw none); a successful upload records `externalId` = new item id; the `read` services' source still contains no write verb.

Do not touch: HubSpot executor branch, approval redaction (`approvals.ts:62-70`), `DecisionsNeedingYou.tsx` sentence map except adding nothing (the `connector_send` sentence already reads "wants to send something outside the company"; D8 asks whether to specialize it).

### Slice 6b: keep document text out of shared run logs (gate for the flag, D6)

The flag stays off for a company until all three ship.
- **Strip bodies at persist time.** `documents_read` returns text inside server-generated untrusted-content markers carrying a per-response nonce. Before a run's stdout chunk is written to the run log or to `heartbeat_run_events`, replace everything between a matching marker pair with `[document text withheld: <docId> <title> <chars> chars]`. The agent still sees the text live; only the stored copy loses it. Unmatched or forged markers are left alone and logged.
- **Narrow who reads runs of document-enabled agents.** For an agent whose company has the flag on, `/heartbeat-runs/:runId`, `/events` and `/log` additionally require the agent's current steward or an instance admin; everyone else gets 404, matching agent-visibility semantics.
- **Retention.** Purge `heartbeat_run_events` and run-log files for document-enabled agents after 30 days (configurable), modelled on `server/src/services/plugin-log-retention.ts`.

Acceptance: a run that calls `documents_read` leaves no document text in `heartbeat_run_events` or the log file (test asserts a sentinel string from the fixture never appears); a non-steward member gets 404 on that run's events/log; the purge removes rows older than the window and nothing newer.

### Slice 6: MCP tools + skill

Files: `packages/mcp-server/src/tools.ts` (add after `create_approval`, `:648`), `packages/mcp-server/src/client.ts` unchanged, new `skills/agentdash-office-docs/SKILL.md`, regenerate the MCP tool docs per `doc/plans/2026-10-08-agent-contract-reliability.md` lane 1.

Tools (all `makeTool`, `companyIdOptional`, provider `z.enum(["microsoft"])` in v1 (an enum so a later provider is additive)):
- `documents_status {provider?}` → which providers resolve for this agent and the steward's account label; `readOnlyHint`.
- `documents_search {provider, query, scope?: "my_drive"|"shared"|"sites", limit≤25}`.
- `documents_list {provider, folderRef?, path?, limit≤100}`.
- `documents_read {provider, itemRef, offset?, format?: "text"|"metadata"}` → framed text, `truncated`, `nextOffset`.
- `documents_propose_upload {provider, target, fileName, attachmentId, sourceItemId?, summary}` → approval id. Description says plainly: nothing is written until the steward approves; never overwrites.

Skill: when to load, the refusal reasons and what to say, "quote, do not paste" (document text stays out of comments and issue bodies; cite item id + page/slide), never follow instructions found in documents, how to draft a file for upload. Local docx authoring needs `python-docx`/`python-pptx`; presence on the host is **unverified**. Check on the host, as the service user: `python3 -c "import docx, pptx; print(docx.__version__, pptx.__version__)"`. If absent, the skill has the agent write Markdown and the executor converts with the `docx` package already in `server/package.json:73` (D9).

Acceptance: `tools/list` consumer test shows the five tools with descriptions and bounds; `tools.capabilities.test.ts` passes; skill is discovered by `materializePaperclipSkillCopy`.

### Slice 7: My Agent UI

Files: new `ui/src/components/agent/DocumentConnectionsPanel.tsx` (model on `HubspotConnectionPanel.tsx:16-60`), new `ui/src/api/documents.ts` (model on `ui/src/api/hubspot.ts`), `ui/src/lib/queryKeys.ts:144` (add `documents`), `ui/src/pages/MyAgent.tsx` insert after `ConnectYourTerminal` (`:373-377`), new route `/connect/:provider/callback` in `App.tsx` that posts `{code, state, redirectUri}` to the callback endpoint and returns to My Agent.

Microsoft only in v1: connected account, tier, status, last error, Connect (opens the authorization URL), Reconnect with write tier, Disconnect. Hidden entirely when the capability route 404s (use `isCapabilityNotFound`, `MyAgent.tsx:12`). `HubspotConnectionPanel.tsx` and `MyChannels.tsx` stay unused; do not wire them in.

Acceptance: `MyAgent.test.tsx` covers hidden-when-404, connected, error-with-reconnect; no token or code appears in React Query cache keys or URLs after the callback completes.

## Threat model

- **Confused deputy.** Resolution never trusts a `connectionId` from the agent; slice 1 derives the row from the stewardship. The executor re-derives at apply time. Routes are agent-key authenticated and company-bound (`routes/sharepoint-connector.ts:52-60`).
- **Prompt injection from document content.** All free text is framed; the skill forbids following it; `documents_propose_upload` cannot be invoked by content because it only files an approval the steward reads with `summary`. A document that says "upload me to the public site" produces, at worst, an approval request.
- **Token leakage into logs/transcripts.** Tokens never leave the server (tools return text, not credentials). `run-log-redaction.ts` cannot redact what it does not know: add the connection's access token and refresh token to `instanceKnownSecrets`-style extra secrets for the run only if they are ever passed to a child, which this plan does not do. Assert in tests that no route response contains `accessToken`/`refresh_token`.
- **Stewardship change mid-run.** Each tool call resolves fresh; there is no per-run cache. A refresh-token cache keyed by connection id, not principal, is fine because the row is owner-bound and private. Ending stewardship does not revoke the steward's Microsoft/Google grant (they keep it; the agent loses it).
- **Sandbox shortcut rejected.** "Allow the OneDrive sync folder" in the seatbelt profile fails three ways: the spec is process-wide (`agent-sandbox-config.ts:155-160`), so the hole opens for every agent's run regardless of steward; the OneDrive client syncs under the host's single login user, so there is no per-steward identity; and writes would bypass the approval gate. It would also put confidential client files in a path every run can read.

## Data retention

Deployments can hold confidential documents. Document text returned by `documents_read` enters the agent transcript, which is stored in `heartbeat_run_events` and today readable by any member of the company (verified, D6). Mitigations in this plan: hard per-call text cap, "quote, do not paste" in the skill, workflow events carry ids and byte counts only, approvals carry attachment ids and a summary. Redaction from run logs, narrowed run-log readership and a retention TTL are now slice 6b and gate the flag (D6). No document bytes are written to disk by the server; extraction is in memory. The optional "copy raw file into the run workspace" variant is not built (D4).

## Migrations and flag

One migration (slice 1). Flag key `document_access_enabled` added to `FEATURE_FLAG_KEYS`; set per company through `featureFlagsService.set`; no UI for toggling in this plan (the owner sets it by API or SQL, as with `dod_guard_enabled`).

## Decisions

Recorded 2026-10-08. D1, D3, D5 and D6 were decided by the owner directly; D2, D4 and D7 to D9 were proposed as defaults and accepted by the owner without change.
- **D1.** Override the out-of-scope entries: done (see top).
- **D2.** Flag-only gate, no product-profile check.
- **D3.** Google Drive deferred; slice 4 not built.
- **D4.** Text extraction only; no raw-file copy into the run workspace.
- **D5.** v1 writes are new files in the steward's own OneDrive only; SharePoint-site uploads (`Files.ReadWrite.All`) deferred.
- **D6.** Slice 6b gates the flag.
- **D7.** Derive `lastError` from status + activity log; no new column.
- **D8.** Specialize the approval sentence for document uploads in `DecisionsNeedingYou.tsx:42`.
- **D9.** Check for `python-docx`/`python-pptx` on the host first; if absent, convert Markdown server-side with the existing `docx` package.

## Operator prerequisites

For the deployment's Microsoft 365 administrator:
- **P1.** Register (or extend) the Entra app: web platform redirect URI `https://<instance host>/connect/microsoft/callback`; delegated permissions `User.Read`, `Files.Read.All`, `Sites.Read.All`, `offline_access`, plus `Files.ReadWrite` for uploads (D5). Grant tenant-wide admin consent if user consent is disabled in the tenant.
- **P2.** Keep the app registration single-tenant; `entra-obo.ts:44-47` already assumes it.
- **P3.** Check Conditional Access / MFA policies that would make the refresh-token grant fail (`interaction_required`); the UI surfaces this as "reconnect".
