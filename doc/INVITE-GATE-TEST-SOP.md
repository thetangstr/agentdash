# Invite-Gate Verification SOP

**Purpose:** prove the self-serve invite gate works on a **pristine instance** (empty DB, no prior state) against the **real** cloud validator — the same path a customer's first MCP signup takes. Run this after any change to the gate (`server/src/routes/onboarding-mcp-signup.ts`, `invite-codes.ts`) or before a launch.

**Canonical runbook for the broader MCP onboarding flow:** [`doc/MCP-LAUNCH.md`](MCP-LAUNCH.md). This SOP covers only gate *enforcement* verification.

---

## 0. Cloud-side prerequisites (do once)

Before the gate can be tested, the **validator authority** must be live:

1. The invite-gate code is on `main` and **deployed to Railway** (`www.agentdash.cloud`). Quick check:
   ```bash
   curl -s -X POST https://www.agentdash.cloud/api/invites/validate \
     -H 'content-type: application/json' -d '{"code":"PROBE"}' -w "\n%{http_code}\n"
   # expect HTTP 200 {"valid":false}  (404 = old code still running; redeploy)
   ```
2. At least one code minted on Railway (`web` service, `production` env):
   ```bash
   railway link -p agentdash && railway service web
   railway variables                      # AGENTDASH_INVITE_CODES must be set
   railway variables --set "AGENTDASH_INVITE_CODES=AGD-<TAG>-<XXXX>"
   ```
   Format: comma-separated (`AGD-ACME-7F3K,AGD-PILOT-92QD`). Empty/unset ⇒ every code invalid.
   `AGENTDASH_INVITE_VALIDATION` must **not** be `off` (unset = gate ON).

---

## 1. Build a lean test image

The prod `Dockerfile` builds agent runtimes (`claude-code`/`codex`/`opencode`) and the UI — none are needed for the gate (it runs before any LLM call). Use this lean `Dockerfile.gate-test` to keep the build fast:

```dockerfile
# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu curl \
  && rm -rf /var/lib/apt/lists/* && corepack enable
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/create-agentdash/package.json packages/create-agentdash/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY patches/ patches/
RUN pnpm install --frozen-lockfile
FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/plugin-sdk build
# Heap bump is required: tsc OOMs (exit 134) without it inside Docker Desktop's ~7.6GB VM.
RUN NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
FROM base AS production
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN mkdir -p /paperclip && chown node:node /paperclip
COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV NODE_ENV=production HOME=/paperclip HOST=0.0.0.0 PORT=3100 SERVE_UI=false \
    PAPERCLIP_HOME=/paperclip PAPERCLIP_INSTANCE_ID=default \
    PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
    PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private
EXPOSE 3100
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
```

Build (from a clean checkout of `main`; the source tree must match what's deployed):

```bash
docker build -f Dockerfile.gate-test -t agentdash-gate-test .
```

> **Slow network / `git fetch` hanging?** Pull the source as a tarball instead (uses HTTPS, not the git protocol):
> `gh api repos/thetangstr/agentdash/tarball/main | tar xz --strip-components=1`

---

## 2. Run the four gate tests

Save as `scripts/test-invite-gate.sh` and run `bash scripts/test-invite-gate.sh`:

```bash
#!/bin/bash
# Two throwaway containers: A) real validator, B) unreachable validator (fail-closed).
set -u
IMG=agentdash-gate-test
CODE="${AGENTDASH_INVITE_CODE:-AGD-D4D-VYG3}"     # a code minted on Railway
REAL="https://www.agentdash.cloud/api/invites/validate"

run() { # name port validator_url
  docker rm -f "$1" >/dev/null 2>&1
  docker run -d --name "$1" -p "$2:3100" \
    -e SERVE_UI=false \
    -e BETTER_AUTH_SECRET=paperclip-dev-secret \
    -e AGENTDASH_SELF_SERVE_BOOTSTRAP=true \
    -e AGENTDASH_INVITE_VALIDATION_URL="$3" "$IMG" >/dev/null 2>&1
}
wait_health() { for i in $(seq 1 60); do
  [ "$(curl -sS -m5 -o /dev/null -w '%{http_code}' localhost:$1/api/health 2>/dev/null)" = 200 ] && return 0
  sleep 5; done; echo "TIMEOUT on :$1"; docker logs "$2" | tail -20; return 1; }
signup() { # port email name [code]
  local b="{\"email\":\"$2\",\"name\":\"$3\"$([ -n "${4:-}" ] && echo ",\"inviteCode\":\"$4\"")}"
  curl -sS -m20 -X POST "localhost:$1/api/onboarding/mcp-signup" -H 'content-type: application/json' \
    -d "$b" -w "\t-> HTTP %{http_code}\n"; }

echo "== A: real validator ==";  run gate-test-a 3101 "$REAL";  wait_health 3101 gate-test-a || exit 1
echo "A1 no code    (expect 403 invite_code_required):";        signup 3101 a1@x.local "A1"
echo "A2 wrong code (expect 403 invalid_invite_code):";         signup 3101 a2@x.local "A2" AGD-FAKE-NOPE
echo "A3 valid code (expect 201, user+apikey created):";        signup 3101 a3@x.local "A3" "$CODE"
docker rm -f gate-test-a >/dev/null 2>&1

echo "== B: unreachable validator (fail-closed) =="; run gate-test-b 3102 "http://192.0.2.1:9/api/invites/validate"
wait_health 3102 gate-test-b || exit 1
echo "B1 valid code, validator down (expect 503 invite_validation_unavailable):"; signup 3102 b1@x.local "B1" "$CODE"
docker rm -f gate-test-b >/dev/null 2>&1; echo DONE
```

---

## 3. Expected results

| # | Scenario | Expected | Meaning |
|---|---|---|---|
| A1 | no `inviteCode` | `403 invite_code_required` | gate blocks before user creation |
| A2 | wrong code | `403 invalid_invite_code` | phones home, validator says `{valid:false}` |
| A3 | valid partner code | `201` + `userId` + `pcp_board_…` apiKey | founding user created |
| B1 | valid code, validator unreachable | `503 invite_validation_unavailable` | **fail-closed** — never creates user on validator outage |

All four must pass. A1/A2 do not pollute the DB (they fail pre-creation); A3 is run last on container A because it creates the founding user.

---

## 4. Troubleshooting (the three real gotchas)

| Symptom | Cause / Fix |
|---|---|
| Every signup → `403 self_serve_bootstrap_disabled` | The invite gate sits **behind** `AGENTDASH_SELF_SERVE_BOOTSTRAP=true`. Set it on the install. (The fresh-Mac bootstrap sets it at `scripts/bootstrap-fresh-mac.sh:91`.) |
| Container exits, logs `BETTER_AUTH_SECRET must be set` | Set `-e BETTER_AUTH_SECRET=…` (any non-empty value for a throwaway test; Railway has it as a real secret). |
| Build fails: `FATAL ERROR … heap out of memory`, exit 134 | `tsc` OOMs. Build with `NODE_OPTIONS=--max-old-space-size=8192` (in the Dockerfile, shown above) or raise Docker Desktop's VM memory. |
| `/api/invites/validate` returns `404` on www.agentdash.cloud | Old code still running on Railway — #458 not deployed. Deploy via `railway up` from a clean `main` checkout/tarball. |
| `railway up --ci` exits 1 with "Failed to stream build logs" | Log-stream network glitch; the upload/deploy usually still proceeds server-side. Verify via the endpoint (§0.1) or `railway status`. |

---

## 5. Mint / rotate a partner code

```bash
railway link -p agentdash && railway service web
# replace the value (or append comma-separated for multiple partners)
railway variables --set "AGENTDASH_INVITE_CODES=AGD-<PARTNERTAG>-<4-RANDOM-ALNUM>"
railway variables   # read back and confirm
```
One code per partner; never reuse. Codes are compared constant-time; the validator is rate-limited (10 req / 15 min) and fails closed when unreachable.

## 6. Cleanup

The test script removes its own containers. To reclaim disk after you're done testing:
```bash
docker rmi agentdash-gate-test   # the lean image (~1.7 GB)
```
