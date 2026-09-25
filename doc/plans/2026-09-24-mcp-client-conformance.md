# MCP client conformance: the stub (#684) and the assistant read toolset (#685) on local clients

Date: 2026-09-24. Scope: localhost only, nothing exposed publicly, nothing merged. This is the stand-in for the founder's Meta Muse test. It runs every agent client installed on the Mac Studio against the two open MCP PRs.

- **Part A** runs the registration stub from PR #684 (`origin/devin/674-muse-mcp-stub`, `tools/spikes/muse-mcp-stub/`). The question is how each client connects to a remote streamable-HTTP MCP server and authenticates.
- **Part B** runs the nine-tool assistant read toolset from PR #685 (`origin/devin/676`, `AGENTDASH_TOOLSET=assistant`) against the real "Agent Runner" board. The prompts are the ones a person would ask, and the question is whether the MCP is intuitive.

## Summary

1. Remote HTTP MCP with OAuth works end to end, with no stub changes, on **MCP Inspector, Codex, Hermes, Devin, and OpenClaw (via mcporter)**. Claude Code headless works with a static bearer. Its OAuth needs the interactive `/mcp` flow, which was not run here. Gemini connects, but its account is blocked on this machine, so OAuth and tool calls went untested.
2. All three registration paths appeared in the log. DCR came from Inspector, mcporter, Devin and Codex. CIMD came from Hermes and Codex, both of which publish a CIMD document. Every OAuth client sent `resource` (RFC 8707) and the advertised `scope`.
3. **The stub has one real conformance bug.** It compares CIMD loopback redirect URIs exactly, port included, so Codex's CIMD path fails. RFC 8252 §7.3 says the port must be ignored for loopback. The production AS needs the same rule.
4. The #685 tool **names** are right: the model's first call was correct for every prompt. The bugs are in **data semantics and server version skew**, not naming:
   - `whats_new` and `list_pending_decisions` 404 on the live instance.
   - The `blocked` section counts only *new* blockers, and both models reported that as "nothing is blocked".
   - "Decisions waiting on me" ignores the seven founder-decision tasks assigned to the board user.
   - Tasks assigned to a human show `owner: null`.
   - The 280-character comment clip made OpenClaw leave MCP and `curl` the raw REST API.

## Part A: the registration stub (PR #684)

### How it was run

```sh
cd tools/spikes/muse-mcp-stub && npm install && node --test server.test.mjs   # 7/7 pass
STUB_STATIC_BEARER=<test token> LOG_FILE=<scratch>/requests.log \
  node --import <scratch>/bind-local.mjs server.mjs
```

`server.mjs` calls `listen(PORT)` with no host, so it binds every interface. To keep the test on localhost, a four-line preload (`bind-local.mjs`) patched `http.Server.prototype.listen` to bind `127.0.0.1`, and `lsof` confirmed `127.0.0.1:8741 (LISTEN)` only. **Recommendation for #684:** add a `HOST` env var that defaults to `127.0.0.1`, and require it to be set explicitly for a public deploy.

A client's traffic was attributed by log line range and User-Agent. The consent click for Inspector, mcporter, Codex, Hermes and Devin was done with browser-harness in a new tab.

### Client × capability matrix

| Client (version) | Remote HTTP MCP | Auth path observed | 401 → PRM → AS metadata | `resource` / `scope` sent | Initialize `protocolVersion` | tools/list | echo + whoami | whoami `auth_via` |
|---|---|---|---|---|---|---|---|---|
| MCP Inspector CLI (UA `node`) | Yes | DCR | Yes / yes / yes | Yes / `mcp:read mcp:write` | 2025-11-25 | Yes | Yes | `oauth` (also `static_bearer` via `--header`) |
| **OpenClaw 2026.2.13** via bundled `mcporter` 0.7.3 | **Partial**: no native MCP client, only the `mcporter` skill (the model shells out to a CLI) | DCR (by mcporter) | Yes / yes / yes | Yes / yes | 2025-11-25 | Yes | Yes (`openclaw agent --local`, model zai/glm-5) | `oauth` |
| Claude Code 2.1.281 (`claude-code/2.1.281 (sdk-cli)`) | Yes | **Static bearer** in headless mode. OAuth discovery ran, but `claude -p` stops at "needs authorization" | Yes / yes / yes | n/a (no token request) | Sends a `server/discover` probe first, then 2025-11-25 | Yes | Yes | `static_bearer` |
| Codex 0.154.0 (`codex-mcp-client/0.154.0`) | Yes | **CIMD** (`https://chatgpt.com/oauth/codex/…/client.json`) rejected by the stub bug. **DCR** works | Yes / yes / yes | Yes / yes | Probe at 2024-11-05, initialize at 2025-06-18 | Yes | Yes, after approval was allowed (see below) | `oauth` |
| Hermes 0.21.2 (`python-httpx2`) | Yes | **CIMD** (`https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json`, fixed ports 27890–27893, so it matched) | Yes / yes / yes | Yes / yes | 2025-11-25 | Yes | Yes (`hermes -z`) | `oauth` |
| Devin 3000.11.3 (rmcp 3.1.0, no UA) | Yes | DCR, automatic on `devin mcp add` | Yes / yes / yes | Yes / yes | Probe at 2024-11-05, initialize at 2025-11-25 | Yes | Yes (`devin -p`) | `oauth` |
| Gemini CLI 0.59.0 | Partial | Static header connects. Unauthenticated, it sends only `initialize`, takes the 401, and does **no discovery** | No / no / no | n/a | Initialize and ping only | Untested | Untested: `gemini -p` fails with `IneligibleTierError` on this account | n/a |

Evidence: the stub's JSONL request log, split per client (`partA-<client>.jsonl`, kept in the session scratchpad, not committed; it holds no secrets because the stub redacts `authorization` and `code_verifier`). Event counts: Inspector, mcporter and Devin show `dcr_register` → `authorize_approved` → `token_issued`. Hermes shows `cimd_fetch` → `authorize_approved` → `token_issued`. Codex shows `cimd_fetch` → `authorize_redirect_mismatch`, then a DCR retry that succeeded.

### Exact commands and config (per invocation, scratch homes)

- **Inspector:** `npx @modelcontextprotocol/inspector --cli http://localhost:8741/mcp --transport http --method tools/call --tool-name whoami`. OAuth needs a TTY or `MCP_AUTO_OPEN_ENABLED=true`.
- **OpenClaw:** `mcporter auth --http-url http://localhost:8741/mcp --allow-http --name musestub`, then `OPENCLAW_STATE_DIR=<scratch>/oc-state OPENCLAW_CONFIG_PATH=<scratch>/oc-state/openclaw.json openclaw agent --local --session-id … --message "…use mcporter…"`. mcporter needs `--allow-http` for plain-http URLs and re-initializes twice per call. OpenClaw's ACP path logs "ignoring N MCP servers".
- **Claude Code:** `claude -p … --mcp-config '{"mcpServers":{"musestub":{"type":"http","url":"http://localhost:8741/mcp","headers":{"Authorization":"Bearer <static>"}}}}' --strict-mcp-config`. The headless OAuth attempt writes a `needs-auth` marker to `~/.claude/mcp-needs-auth-cache.json`.
- **Codex:** scratch `CODEX_HOME`. `codex mcp add musestub --url http://localhost:8741/mcp --oauth-client-registration cimd|dcr`, `codex mcp login musestub`, then `codex exec -c mcp_servers.musestub.default_tools_approval_mode="approve" …`. Without that override, `codex exec` refuses the call: "requires approval, but approval policy is never". The stub's tools carry no `readOnlyHint`. The #685 tools do, and they are expected not to hit this, but that was not verified here.
- **Hermes:** scratch `HERMES_HOME` copied from the `ccworker` profile, with `mcp_servers.stubh: {url, auth: oauth}`. `hermes mcp login stubh` needs a TTY, so it ran in tmux. Then `hermes -z "…"`.
- **Devin:** local-scope `.devin/mcp_config.local.json` in a scratch directory. `devin mcp add` runs DCR, then `devin -p --permission-mode dangerous --respect-workspace-trust false "…"`.
- **Gemini:** project-local `.gemini/settings.json` with `{"mcpServers":{"musestub":{"httpUrl":"http://localhost:8741/mcp","headers":{…}}}}` in a scratch cwd, then `gemini mcp list`.

### Part A findings for the stub and the production AS

1. **CIMD loopback redirect matching (bug).** Codex's CIMD document registers `http://127.0.0.1/callback/<id>` and `http://localhost/callback/<id>` with no port, and it redirects to an ephemeral port such as `http://127.0.0.1:63346/callback/<id>`. The stub's `client.redirect_uris.includes(redirectUri)` rejects that. Fix: when the registered URI's host is `127.0.0.1`, `[::1]` or `localhost` and its scheme is `http`, compare everything except the port (RFC 8252 §7.3). The production authorization server needs this on day one, because Codex and any CIMD desktop client depend on it.
2. **Bind host.** Add a `HOST` env var to the stub (see above).
3. **CIMD needs outbound fetch.** The stub fetched `chatgpt.com` and `nousresearch.github.io` to resolve `client_id`. That is expected, but a locked-down egress policy on the future AS host will break CIMD silently. List it as a deploy requirement.
4. **Pre-2025-11-25 clients.** Codex initializes at `2025-06-18` and still completed OAuth, because PRM discovery via `WWW-Authenticate` works for both revisions. No change is needed, but the production server must not assume 2025-11-25.
5. **Read-only annotations matter to Codex.** Headless Codex will not call a tool that lacks `readOnlyHint` unless approval is configured. #685 already annotates every tool. Keep that as a hard rule for M2 tools, where approval prompts will fire for writes.
6. **Claude Code headless cannot complete OAuth.** A Claude.ai connector test needs a public URL. A local Claude Code OAuth test needs an interactive `/mcp` session, which stores the token in the shared keychain credential, so it was skipped deliberately.

## Part B: the assistant read toolset (PR #685) driven as an assistant

### Setup

- Built `packages/mcp-server` from `origin/devin/676` (6b8fc8cd4) in a throwaway worktree: `pnpm --filter @agentdash/mcp-server build`.
- stdio config, passed per invocation (`claude -p --mcp-config <file> --strict-mcp-config --tools "" --allowedTools "mcp__agentdash__*" --setting-sources "" --no-session-persistence`, run from a scratch directory so no project CLAUDE.md or hooks leak in):

  ```json
  {"mcpServers":{"agentdash":{"type":"stdio","command":"node",
    "args":["<worktree>/packages/mcp-server/dist/stdio.js"],
    "env":{"AGENTDASH_API_URL":"http://127.0.0.1:3199",
           "AGENTDASH_COMPANY_ID":"ff60936e-fd79-4a34-98ae-02e5e7a07250",
           "AGENTDASH_TOOLSET":"assistant"}}}}
  ```

- **Auth.** `readConfigFromEnv` takes `PAPERCLIP_API_URL`/`AGENTDASH_API_URL` (required, `/api` appended), `PAPERCLIP_API_KEY`/`AGENTDASH_API_KEY` (optional) and `PAPERCLIP_COMPANY_ID`/`AGENTDASH_COMPANY_ID`. On a `local_trusted` instance the actor middleware makes every request without a bearer the implicit board actor (`userId: "local-board"`, `source: "local_implicit"`, instance admin), so **no key is needed and none was minted**. `whoami` reports exactly that.
- **Version skew.** The live `:3199` instance runs `ota/integration-mkthink` (cc217bdca), which does not have the two server routes #685 adds. `GET /companies/:id/assistant/digest` and `/assistant/pending-decisions` return 404 there, so `whats_new` and `list_pending_decisions` fail on the live board. To test them on real data **without touching the live instance**, I restored the instance's own hourly backup (`paperclip-20260923-234030.sql.gz`, taken 06:40Z) into a scratch Postgres 18 on `127.0.0.1:55499`, paused every agent and routine **in the copy**, and ran the `devin/676` server against it on `127.0.0.1:3198` with the heartbeat scheduler, run healer, backups, digest and evaluator ingest disabled and an isolated `PAPERCLIP_HOME`/`PAPERCLIP_INSTANCE_ID`. Both are torn down. The live instance received only GETs.
- Model: Claude Code default (`claude-opus-5-5`), with repeat runs on `sonnet` for the two start-here prompts.

### Per-prompt results

| Prompt | Instance | Tools the model chose (in order) | Turns | Correct against the board? |
|---|---|---|---|---|
| "what did my agents ship in the last day?" | live :3199 | `whats_new` (404) → `find_work status=done limit=25` → `find_work limit=100` (raw zod error) → `list_projects` → `find_work status=in_review` → `get_work_item` AGE-181, AGE-180 | 8 | **Yes.** Only AGE-181 completed in the window (API: 1 issue with `completedAt` ≥ now-24h). It also flagged AGE-180 as near-shipped and said honestly that its view might be incomplete |
| same | snapshot :3198 | `whats_new since="2026-09-23"` | 2 | Shipped list correct (AGE-181). **But it said "Nothing is blocked"**, while 8 tasks are blocked: the digest's `blocked` section only counts blockers that are new in the window. Sonnet made the same claim. Opus noticed that a date-only `since` gives a 31-hour window; Sonnet did not |
| "what's blocked and why?" | live and snapshot | `find_work status=blocked` → `explain_blocker` ×8 → `get_work_item` ×5–6 (plus `list_pending_decisions` on the snapshot) | 16–17 | **Yes**, all 8 (API: AGE-59, 3, 91, 50, 25, 104, 26, 4). The synthesis (two merge decisions unblock three tasks; one `git push` clears AGE-91) was accurate. The model needed a 16-call fan-out because `explain_blocker` returned `"no explicit reason recorded"` for 6 of 8 and it had to walk dependencies |
| "what decisions are waiting on me?" | live :3199 | `list_pending_decisions` (404) → `whats_new` (404) → `whoami` → `find_work status=blocked` | 5 | Honest fallback, and it said the blocked list is not the approval queue |
| same | snapshot :3198 | `list_pending_decisions` | 2 | **Misleading.** "Nothing is waiting on you" is literally true for approvals (API: 0 pending), but the board has **7 open issues assigned to the board user** whose titles say they are founder decisions (AGE-56, AGE-57 "Eyan merge decision: PR #…", AGE-58, AGE-51, AGE-26 "DECISION: …", AGE-89, AGE-17). None of them can be reached as "mine" through any tool |
| "tell me about AGE-179" | both | `get_work_item` → `explain_blocker` | 3 | **Yes, but incomplete.** Status, owner, project and origin were right. Maya's disposition comment is clipped at 280 characters, so the model could name only one of the four closures and none of the remaining two bugs (the full comment names GH #554, #449, #297, #550 and the AGE-180 mirror). It sent the user to the web UI |
| Extra: "what is Jules working on?" | snapshot | `find_work agent=Jules` ×4 (by status) + `list_team` | 6 | Correct task buckets. The "paused" states came from my copy, where I paused the agents. The live `list_team` reports idle |
| Extra: "how is the evaluator project going?" | snapshot | `get_project project=evaluator` | 2 | Correct `needs_clarification` with two candidates. The ambiguity contract works as designed |

Cost per prompt with the digest routes present: $0.005 to $0.03. Without them, the fan-out costs $0.14 to $0.16 and 8 to 17 turns.

### What the model found intuitive

- **The tool names matched the prompts.** The model picked `whats_new` for "ship", `list_pending_decisions` for "decisions waiting on me", `get_work_item` for an identifier, and `get_project` for a project name. Each was its first call, with no wrong first picks. The "Start here for 'what happened'" hint in `whats_new` worked.
- **The envelope `summary` is quotable.** Most final answers paraphrase the summary and then pull detail from `data`. The deep links ended up in every answer.
- **The `agentWrote` framing held.** Every answer attributed agent text ("Jules wrote…", "Maya says…") and did not state it as fact.
- **`needs_clarification` worked** without a follow-up guess.

### OpenClaw driving the same toolset (stdio through mcporter)

OpenClaw has no native MCP client, so the stdio server was declared in a project-local `config/mcporter.json` inside a scratch OpenClaw workspace. The command and env were the same as the Claude config, pointed at the snapshot on `:3198`. The model was `zai/glm-5` with an isolated `OPENCLAW_STATE_DIR`. Each prompt carried one hint: "My AgentDash workspace is available as the MCP server 'agentdash' through mcporter". Without that hint, OpenClaw has no way to know the server exists. That is a Muse-relevant signal in itself: in an assistant with no native connector, the tools are invisible.

| Prompt | What OpenClaw did | Correct? |
|---|---|---|
| shipped last day | Read the mcporter skill → `mcporter list --schema` → `whats_new since=<now-24h>` → **guessed `get_work_item {"query":…}`** (wrong parameter name, failed) → `get_work_item ref=AGE-181`, `ref=AGE-180` | **Yes**, and it computed a true 24-hour window. It reported "Blockers: 0 new", which is correct wording |
| blocked and why | `find_work status=blocked` → `explain_blocker` over all 8 in one shell loop → `list_pending_decisions` | **Yes.** It also said on its own that the empty decision queue contradicts the founder-decision tasks: "the merge/token decisions above exist as dependency items but aren't registered as formal decisions, so they may be quietly aging" |
| decisions waiting on me | `list_pending_decisions` → `whats_new` | **Wrong.** "Nothing is waiting on you… Blocked/stalled work: 0." Both halves are false for this board |
| tell me about AGE-179 | `get_work_item ref=AGE-179` → `find_work q=AGE-179` (guessed parameter) → `explain_blocker` → **`web_fetch` of the UI URL → `curl` of `/api/companies/:id/issues` and `/api/issues/:id/comments`** | **Yes, and complete**, but only because it **left MCP** and read the raw REST API. On a `local_trusted` instance that API needs no credentials, so the redaction boundary in #685 did not apply to what it read. Every call was a GET, and it hit the snapshot, not the live instance |

### Usability findings, ranked

1. **Version skew breaks the two "start here" tools.** `whats_new` and `list_pending_decisions` depend on server routes that ship in the same PR. Any instance that is not on #685's server (today that includes `:3199`) returns a 404, and the model sees `"Something went wrong reaching AgentDash: AgentDash answered 404 for GET /companies/<uuid>/assistant/digest…"`. Without those routes the same questions cost 5 to 17 turns and $0.05 to $0.16, against 2 turns and $0.005 to $0.03 with them. The error also echoes the internal route and company UUID.
2. **The `blocked` section of `whats_new` reads as "nothing is blocked".** The digest counts only blockers that are new in the window. Opus, Sonnet and GLM-5 all turned `blocked.total: 0` into "Nothing is blocked" or "Blocked/stalled work: 0", while 8 tasks are blocked.
3. **"Decisions waiting on me" misses how this company records decisions.** `list_pending_decisions` covers approvals and agent questions (0 here). The founder's decisions live as **tasks assigned to the board user**: AGE-56 and AGE-57 "Eyan merge decision: PR #…", AGE-26 "DECISION: …", AGE-58, AGE-51, AGE-89, AGE-17. No tool returns "tasks assigned to me". `find_work agent=` resolves agents only: `Eyan`, `me` and `local-board` all return "I couldn't find person or agent matching that", although the description says "person or agent".
4. **Human owners show as `owner: null`.** `itemCard` looks up only `assigneeAgentId`, so a task assigned to the founder reads as unowned. Claude described AGE-26 and AGE-4 as "no owner" when AGE-26 is assigned to the user asking.
5. **The 280-character clip hides the answer, and weaker models route around MCP.** AGE-179's key content is one long agent comment. Claude said it could not see the rest and sent the user to the UI. OpenClaw/GLM-5 `curl`ed the unauthenticated local API instead.
6. **`explain_blocker` usually has no reason.** 6 of 8 blocked tasks returned `"no explicit reason recorded"`, so the model walked dependencies itself: 8 `explain_blocker` calls plus 5 to 6 `get_work_item` calls for one question. In other cases the "reason" is a liveness classifier string, such as "Run produced concrete action evidence: 9 activity event(s)" for AGE-26, which is not a reason. Cancelled dependencies (AGE-54) are still listed as blockers.
7. **The tools point at tools that do not exist.** `explain_blocker.unblockOptions` names `comment_on_work` and `assign_work`, and `find_work` says "Use before creating a task". None of these exist in M1. Not-found messages end "Nothing was changed.", which is odd for a read-only toolset.
8. **Parameters have no descriptions.** In the emitted `tools/list`, `since`, `query`, `status` and `limit` have no `description`. The `.describe()` on `sinceInput` is lost after `.optional()`. The models then passed `since: "2026-09-23"`, a 31-hour window that only Opus noticed. GLM-5 guessed `query` and `q` for `ref`. `limit` above 25 returns a raw zod error array rather than the envelope.
9. **`oneLine` is often a markdown heading.** It is the first line of the description, so many cards read `"oneLine": "## Outcome"` or `"## Decision"`.
10. **Smaller issues.** The `list_team` summary drops the sixth agent ("and 1 more"), and that agent was Maya, the CEO. `find_work` sorts by priority with no recency order or `since` filter, so "what finished yesterday" without the digest is a guess, and Claude said so.

### What worked, and should stay

- The names and one-line descriptions: every first tool choice was right on all three models.
- The `summary` + `data` + `links.primary` envelope. Every answer carried a deep link.
- `agentWrote` framing. Every model attributed agent text instead of asserting it.
- `needs_clarification` for "evaluator", which matched two projects.
- The read-only boundary. No tool call mutated anything, and `readOnlyHint` is on all nine tools.

## Recommendations

### M1 (before #685 merges)

1. **Ship the server routes and the MCP package together, and fail usefully when they are missing.** When the digest or pending-decisions route returns 404, return a `refused` envelope with an actionable summary ("This AgentDash instance is older than the assistant tools; update it to use whats_new") and no route or UUID. Optionally probe `/api/health` for a capability flag at startup.
2. **Rename and restate the digest's blocked section.** Use `newlyBlocked`, plus a `stillBlocked.total` count, and make the summary say "no new blockers since X; 8 tasks are still blocked".
3. **Make "waiting on me" include tasks assigned to the caller.** Add a `assignedToYou` section to `list_pending_decisions` (open issues with `assigneeUserId = caller`), or add `find_work assignee="me"`. Resolve humans in the `agent` or `person` reference, or rename the parameter `agent` and drop "person" from its description.
4. **Show human owners.** Set `owner: {name, kind: "person"}` from `assigneeUserId`, and "you" when it is the caller.
5. **Give every parameter a description, and put `.describe()` outermost.** `since`: "ISO 8601 time or a duration like 24h; for 'last day' use 24h". `limit`: "max 25". `status`: say `blocked` means marked blocked. Clamp `limit` rather than returning a raw zod error, and wrap validation errors in the envelope.
6. **Take M2 tools out of M1 text.** Drop "Use before creating a task" and the `comment_on_work`/`assign_work` hints until those tools exist, or mark them "(coming later)". Change "Nothing was changed." to a plain not-found.
7. **Raise the comment budget in `get_work_item`.** Give the latest comment 1,200 characters and the older ones 280. Alternatively, add `get_work_item {ref, full_comment: true}` so the model has an in-MCP path and does not fall back to the REST API.
8. **Make `explain_blocker` state the chain.** Follow open dependencies (skip `cancelled`/`done`), name the terminal blocker and whether it is assigned to the caller, and put the liveness string under `evidence`, not `reason`.
9. **Card `oneLine`: skip markdown headings.** Use the first non-heading sentence.

### M2 and the remote transport

1. **Authorization server:** DCR and CIMD both, with RFC 8252 loopback-port-insensitive redirect matching, `resource` binding and PKCE S256. Every OAuth client here used all of them. Support both protocol revisions, 2025-06-18 and 2025-11-25.
2. **Keep the static-bearer path** as a first-class fallback: Claude Code headless and Gemini can only use it today.
3. **Close the local REST bypass for assistants.** An assistant with a shell or `web_fetch` read `/api` directly on a `local_trusted` board. The remote server will not have this problem, but a local stdio setup does. Document it, or bind assistant use to an authenticated deployment.
4. **Write tools (`comment_on_work`, `assign_work`, `decide`)** must carry `destructiveHint`/`readOnlyHint: false`, so Codex, Devin and Claude approval flows fire. The Sentinel-style confirmation Muse is expected to show can only be tested on a public URL.
5. **Assistant-native discovery.** OpenClaw needed to be told the server existed. For assistants without connectors, a short skill or instructions file ("ask AgentDash with mcporter call agentdash.whats_new") is the integration surface. That may be what Muse looks like too.

## Not testable without a public URL

- **Meta Muse, Grok and Claude.ai custom connectors.** All three fetch the MCP URL from their own cloud, so they need `https://` on the public internet. A consent redirect on `localhost` would also be unreachable from their side. Still open: the connector-entry route (URL field, developer console or directory), the registration path they choose, whether they send `resource` and `scope`, how their confirmation UI surfaces `readOnlyHint`, and whether a directory listing can carry a per-user server URL. The founder runbook in #684 covers these.
- **Claude Code interactive OAuth.** It is possible locally, but it writes to the shared keychain credential, so it was skipped deliberately.
- **Gemini OAuth and tool calls.** The account on this Mac fails with `IneligibleTierError`. Retry with an API key.

## Config changes made and reverted

- `~/.mcp-inspector/`: created by Inspector OAuth, then deleted. It did not exist before.
- `~/.mcporter/credentials.json`: created by mcporter OAuth, then deleted. `diff -r` against the backup is clean, and `~/.mcporter/mcporter.json` was untouched (mtime Aug 29).
- `~/.claude/mcp-needs-auth-cache.json`: gained a `musestub` key, which was removed. Other keys are untouched.
- `~/.gemini/history/` and `~/.gemini/projects.json`: created by the Gemini CLI, then deleted. `settings.json` is unchanged.
- `~/.local/share/devin/mcp/oauth/<id>.json`: removed with `devin mcp logout`. **Not reverted:** `devin -p` appended one session to Devin's `sessions.db` and wrote logs.
- Codex, Hermes and OpenClaw ran only with scratch homes (`CODEX_HOME`, `HERMES_HOME`, `OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH`). `~/.codex`, `~/.hermes` and `~/.openclaw` were not touched.
- Browser: Codex, Hermes and Devin each auto-opened a consent tab in the user's Chrome. Those tabs were closed. One stale `127.0.0.1:57144/oauth/callback?code=…` tab that this run did not open was also closed by the URL-pattern cleanup.
- Live instance `:3199`: GET requests only; nothing minted, nothing written. The snapshot Postgres (`:55499`), the snapshot server (`:3198`) and the stub (`:8741`) are all stopped and deleted.
