# Self-serve cloud SC-0 spike: findings

**Issue:** GH #761. **Design:** `docs/superpowers/specs/2026-09-25-self-serve-cloud-design.md` (PR #755), §3.3 and §4.
**Date:** 2026-09-25 (measurements taken 03:56 to 04:20 UTC on 2026-09-26).
**Status:** measured, with the Pro-only answers blocked on F1 (#756) and the DNS answers blocked on F3 (#758). See §7.

## 0. Answers in one screen

| Question | Answer | Confidence |
|---|---|---|
| Postgres without the CLI | **Yes, option (a).** `serviceCreate` (no source) → `volumeCreate` at `/var/lib/postgresql/data` → `variableCollectionUpsert` (password generated in memory, `skipDeploys: true`) → `serviceInstanceUpdate` with `source.image = ghcr.io/railwayapp-templates/postgres-ssl:17`. Ready in about 5 s. The web service uses `DATABASE_URL = ${{Postgres.DATABASE_URL}}`, exactly as `provision-box.sh` does today | Measured |
| Does Railway's edge keep `X-Forwarded-Host`? | **No, it overwrites it** with the Host it routed on (the box's Railway host). It also overwrites `X-Forwarded-For`, `X-Real-IP` and `X-Railway-Edge`. Custom headers such as `X-AgentDash-Client-IP` pass through untouched, **including when a client sends them straight to the Railway host** | Measured |
| WebSocket through both edges | **Survives.** Open 610 s through the router (and 610 s direct), 21 of 21 server messages received, no drop | Measured |
| Chunked streaming through both edges | **Unbuffered.** 10 chunks written 500 ms apart arrived 500 ms apart, about 40 ms after each was written | Measured |
| Added latency of the router hop | **p50 +25 ms, p95 +25 to 38 ms** over 200 requests (direct p50 30 ms, p95 35 to 44 ms; through the router p50 55 to 56 ms, p95 60 to 82 ms) | Measured |
| Volume service outage on redeploy | **7.0 s** on `serviceInstanceRedeploy`, **4.8 s** on a new image, for a server that listens instantly. A box's outage is that plus AgentDash's own boot to listening | Measured |
| Wildcard domain records | Railway prints **three** records per wildcard, all readable from the API: `*` CNAME to `<id>.up.railway.app`, `_acme-challenge` CNAME to **`<id>.authorize.railwaydns.net`** (per-domain, not the bare `authorize.railwaydns.net`), and a TXT at `_railway-verify` | Measured (records printed; not issued, no DNS) |
| Volume snapshots by API | `volumeInstanceBackupScheduleUpdate(kinds: [DAILY, WEEKLY])` exists; Hobby refuses it (`Not Authorized`, plan limit `maxBackupsCount: 0`) | **Blocked on #756** |

## 1. How the spike was run

- **Railway account:** the founder's existing Hobby workspace, because the dedicated Pro workspace (#756) does not exist yet. One throwaway project, `agentdash-spike-20260925`, was created and then **deleted by `projectDelete`** at the end; the workspace's project list afterwards shows only the five pre-existing projects. No other project was read or changed.
- **Everything by GraphQL** against `https://backboard.railway.com/graphql/v2`, with no CLI step in the create path. The schema answers anonymous introspection, which is how the mutations below were found; every call that changes state needs a token.
- **Test services:** a Postgres from Railway's image; a `web` stand-in (`node:22-alpine` running a small echo server: `/health`, `/headers`, `/db` (a TCP connect to `DATABASE_URL`'s host), `/stream` (chunked), and a WebSocket that sends a message every 30 s), with a Volume at `/data`; and a `proxy` stand-in for the router (Node `http` + `https` with a keep-alive agent and a raw TLS pipe for upgrades) that rewrites `Host` to the echo's Railway host and sets `X-Forwarded-Host`, `X-Forwarded-For` and `X-AgentDash-Client-IP`.
- **Deviation from the brief:** the issue asked for the proxy and the echo in **two** projects. The brief also allows only one throwaway project, so both ran in one project, with the proxy calling the echo **through its public Railway domain**. The path is the same one the router will take (client → Railway edge → router → Railway edge → box); Railway's private network is per project, so the router cannot use it to reach a box in another project either way.
- **Where it ran:** requests left from a workstation on the US West Coast and entered Railway at the `lax1` edge; services ran in the workspace's default region.

## 2. Postgres by API (spec §3.3 step 3)

### 2.1 The calls that worked

Secrets are shown as placeholders; the real password came from a CSPRNG in the worker's memory and was never printed.

```graphql
# 1. The service, with no source yet (so nothing deploys before the volume exists)
mutation { serviceCreate(input: { projectId: $P, environmentId: $E, name: "Postgres" }) { id } }

# 2. Its volume at the data directory
mutation { volumeCreate(input: { projectId: $P, environmentId: $E, serviceId: $PG,
                                 mountPath: "/var/lib/postgresql/data" }) { id } }

# 3. Variables, without triggering a deploy
mutation { variableCollectionUpsert(input: { projectId: $P, environmentId: $E, serviceId: $PG,
  skipDeploys: true, variables: {
    PGDATA: "/var/lib/postgresql/data/pgdata",
    POSTGRES_USER: "postgres", POSTGRES_DB: "railway",
    POSTGRES_PASSWORD: "<32 random alphanumerics, generated in memory>",
    PGHOST: "${{RAILWAY_PRIVATE_DOMAIN}}", PGPORT: "5432",
    PGUSER: "${{POSTGRES_USER}}", PGDATABASE: "${{POSTGRES_DB}}", PGPASSWORD: "${{POSTGRES_PASSWORD}}",
    DATABASE_URL: "postgresql://${{PGUSER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{PGDATABASE}}",
    RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "60", SSL_CERT_DAYS: "820" } }) }

# 4. The image (major version pinned) plus restart policy. This call itself starts a deployment.
mutation { serviceInstanceUpdate(serviceId: $PG, environmentId: $E, input: {
  source: { image: "ghcr.io/railwayapp-templates/postgres-ssl:17" },
  restartPolicyType: ON_FAILURE, restartPolicyMaxRetries: 10 }) }
```

The web service then gets `DATABASE_URL: "${{Postgres.DATABASE_URL}}"` in its own `variableCollectionUpsert`, the same reference `provision-box.sh` writes (line 259 on main). The reference resolved to `postgresql://postgres:…@postgres.railway.internal:5432/railway` with the full 32-character password, and a TCP connect from `web` to `postgres.railway.internal:5432` succeeded in 26 ms.

The variable set is copied from Railway's own Postgres template (`template(code: "postgres") { serializedConfig }`), so the Data panel, `PG*` variables and `DATABASE_URL` look exactly as they do for a template-created database. Postgres 17.11 started, ran its init scripts (SSL certificate, pgBackRest hook) and accepted connections about **5 s** after the deployment was created.

### 2.2 Findings that change the port

1. **Pin the major version.** The template now defaults to `postgres-ssl:18`. Boxes created by `railway add --database postgres` from today on get 18; the launch box predates that. SC-2 should pin one major (17 was used here) and record it on the box row. Upgrading a box's major later is a dump and restore, not an image change.
2. **`serviceInstanceUpdate` with a `source` deploys by itself.** Calling `serviceInstanceDeployV2` right after it created a second deployment and cancelled the first (the first shows `REMOVED` one second later). The port should set the source **last**, in one `serviceInstanceUpdate` with the rest of the service settings, and then poll `deployments(input: { serviceId, environmentId }, first: 1)` rather than call deploy again. `serviceInstanceDeployV2` is still the right call for a later redeploy with changed variables.
3. **Deploying a service with no source fails with a misleading error** (`Deployment not found`). If a source update is refused (see 4), the deploy call must not be treated as the failure to diagnose.
4. **`healthcheckPath` is validated;** `/proxy-health` was refused with `Invalid input`, `/proxyhealth` and `/health` were accepted. The box uses `/api/health`, which has no hyphen; keep it that way or test the exact value first.
5. **Option (b), `templateDeployV2`, is not needed.** It takes a `serializedConfig` of the whole template and generates the password server-side from `${{ secret(32, …) }}`, which would put the password outside the worker's control and the value only readable back through a variables query. Option (a) keeps the spec's rule that secrets are generated in the worker and live in memory for one request.
6. **Idempotency:** each step returns its ID immediately (`serviceCreate`, `volumeCreate`), so the port can record `pg_service_id` before the next call, as §3.2 requires. A resumed job finds the service by name in `project { services }` and its volume in `project { volumes { volumeInstances { serviceId mountPath } } }`.

## 3. The router through two Railway edges (spec §4.3, §4.4)

### 3.1 Headers

What the echo service received, by path (the tester's public IP is written as `CLIENT`, the router's egress IP as `ROUTER`, Railway edge addresses as `EDGE`):

| Header | Sent straight to the box's Railway host, with forged values | Through the router |
|---|---|---|
| `Host` | the Railway host | the Railway host (the router set it) |
| `X-Forwarded-Host` | forged `evil.example` **replaced** by the Railway host | router's value (the public name) **replaced** by the Railway host |
| `X-Forwarded-For` | forged `6.6.6.6` **replaced** by `CLIENT, EDGE` | `ROUTER, EDGE`: the router's `CLIENT, EDGE` was replaced |
| `X-Real-IP` | forged `9.9.9.9` **replaced** by `CLIENT` | `ROUTER` |
| `X-Railway-Edge` | forged value **replaced** by `lax1` | `lax1` |
| `X-AgentDash-Client-IP` | forged `7.7.7.7` **passed through unchanged** | the router's `CLIENT` passed through unchanged |
| `Accept-Encoding` | `gzip` added | `gzip` added |

Consequences:

- **The box can never learn its public name from `X-Forwarded-Host`.** §4.4 already has the box trust `PAPERCLIP_PUBLIC_URL` (the issuer, Origin checks and links all come from `publicBaseUrl`), which is what makes the design work. §4.3's "adds `X-Forwarded-Host`" should be dropped or renamed: if the box ever needs the name the visitor used, the router has to send it in a custom header (for example `X-AgentDash-Forwarded-Host`), covered by the same edge-secret check.
- **Behind the router every visitor's `X-Forwarded-For` and `X-Real-IP` is the router's egress address.** The box's current `trust proxy = 1` would rate-limit every visitor as one client. §4.4's design (take the client IP from `X-AgentDash-Client-IP` only when `X-AgentDash-Edge` matches) is **confirmed necessary**.
- **Custom headers are not stripped by Railway's edge.** A client that calls the box's Railway host directly can send its own `X-AgentDash-Client-IP` and `X-AgentDash-Edge`. The edge secret, compared in constant time, is the only thing that makes those headers trustworthy, and the box must refuse requests without it (except `GET /api/health`), exactly as §4.4 says. The router must also **overwrite**, not append to, both headers on every request.
- For the control plane itself (SC-1), Railway's overwrite of `X-Real-IP` means `X-Real-IP` is a trustworthy client address for a service reached on its own Railway domain. SC-1's admin IP allow-list uses it that way when `CLOUD_CLIENT_IP_SOURCE=x-real-ip`.

### 3.2 WebSocket

A WebSocket opened through the router (`wss://proxy…/ws`) and one opened directly both stayed open for the full **610 s** test, each receiving all 21 messages the server sent every 30 s, and closed cleanly from the client side. The first attempt closed with 1006 at 86 s; that was the spike's own `serviceInstanceRedeploy` of the echo service stopping the old container, not a Railway limit (the close lines up with the old deployment's `REMOVED` time). A redeploy of a box therefore drops its live-events sockets, which the UI already reconnects.

This matches Railway's published limits: WebSockets are exempt from the 15-minute and 5-minute-idle HTTP limits. A socket idle for longer than 5 minutes was not tested (the server sent a message every 30 s); the box's live-events socket also sends traffic, so this does not block anything.

### 3.3 Streaming

`/stream` writes 10 chunks 500 ms apart. Through the router they arrived 500 ms apart, each about 40 ms after the server wrote it (server and client clocks compared). Neither Railway edge nor the Node proxy buffered the response. The assistant MCP endpoint is plain JSON today, so this matters only for future streaming responses.

### 3.4 Latency

Two runs of 200 interleaved requests to `/headers`, warm keep-alive connections, from the same client:

| Run | Direct p50 | Direct p95 | Through router p50 | Through router p95 | Added p50 | Added p95 |
|---|---|---|---|---|---|---|
| 1 | 30.5 ms | 43.6 ms | 56.0 ms | 82.0 ms | +25.5 ms | +38.4 ms |
| 2 | 30.2 ms | 34.9 ms | 54.9 ms | 59.6 ms | +24.7 ms | +24.7 ms |

The router hop costs about **25 ms at p50**, above the spec's estimate of 5 to 20 ms (§4.5): the second hop leaves Railway and re-enters through its public edge, with TLS to the box. That is small next to a page load, but it is per request, so the router should keep connections to boxes alive (the spike's proxy did) and must not add a DNS lookup or TLS handshake per request. Running the router in the same region as the boxes is assumed; a region mismatch would add more.

## 4. Volume redeploy downtime (spec §3.5, §6.1)

A 250 ms poller hit the echo's `/health` directly while the service (with a Volume) was redeployed:

| Action | API call | Outage | Deployment created to `SUCCESS` |
|---|---|---|---|
| Redeploy, same image | `serviceInstanceRedeploy(serviceId, environmentId)` | **7.0 s** | 18.5 s |
| New image | `serviceInstanceUpdate(source.image = node:24-alpine)` then deploy | **4.8 s** | 17.1 s |

Railway cannot overlap two deployments that share a Volume, so it builds and pulls the new one, then stops the old container, then starts the new one. The measured gap is the platform's part for a server that is listening within milliseconds. For a box, add AgentDash's boot to listening (migrations on start, plugin load), which this spike did not measure because it would mean deploying the real image; the spec's "about a minute" per release is a reasonable upper bound until SC-2 times a real box. This confirms §3.5 step 5: `close_signup` variables go in with `skipDeploys: true` and ride the next deploy.

## 5. Wildcard domain and TLS (spec §4.1, §4.2)

`customDomainCreate(input: { domain: "*.sc0-spike.agentdash.cloud", serviceId, environmentId, projectId, targetPort: 8080 })` succeeded on Hobby and returned, through `status { dnsRecords … verificationDnsHost verificationToken }`:

| Type | Host (label under the zone) | Value | Purpose |
|---|---|---|---|
| CNAME | `*.sc0-spike` | `<id>.up.railway.app` | traffic |
| CNAME | `_acme-challenge.sc0-spike` | `<id>.authorize.railwaydns.net` | DNS-01 delegation |
| TXT | `_railway-verify.sc0-spike` | a 79-character token | ownership |

Certificate status stayed `VALIDATING_OWNERSHIP`, as expected with no records at GoDaddy; the domain was removed with the project.

- **Correction to §4.1:** the `_acme-challenge` target is a **per-domain** name, `<id>.authorize.railwaydns.net`, not the bare `authorize.railwaydns.net`. It is still static (set once, answers every renewal), so the design holds; the founder must copy the value Railway prints, which SC-4 can read from the API and print.
- The ownership TXT lives at `_railway-verify.<label>`. For the real router domain `*.agentdash.cloud`, the three records are `*`, `_acme-challenge` and `_railway-verify` at the apex zone.
- Explicit records keep precedence over a wildcard in DNS, so `www`, `hq` and mail are unaffected, as §4.1 says.
- **Not verified here:** issuance time, and whether a Hobby service can issue a wildcard certificate at all. Both need the records at GoDaddy (#758).

## 6. Limits read from the API

From `project { subscriptionPlanLimit }` on the Hobby workspace, plus Railway's documentation for Pro:

| Limit | Hobby (read) | Pro (documented) |
|---|---|---|
| Projects per workspace | 50 | 100 |
| Services per project | 50 | |
| Volumes per project | 10, 5 GB max each | larger |
| Volume backups (snapshots) | **0** (API refuses) | allowed |
| Custom domains per service | 2 | 20 |
| Service domains per service | 4 | |
| API requests | 1,000 an hour, 10 a second | 10,000 an hour, 50 a second |
| HTTP response timeout | 900 s | 900 s |
| Requests per second per host | 10,000 (burst 25,000) | |

The spike's three-service project took 17 mutations to create (one project, three services, two volumes, three variable sets, two domains, three service updates, three deploy calls, the last three redundant per §2.2) plus status polling, 58 calls in all including the measurements; the spec's estimate of 60 to 100 calls per box including polling and health checks is consistent with that, well inside Pro's hourly budget at 3 concurrent jobs.

## 7. What is blocked on the founder actions

| Answer | Blocked on | Why |
|---|---|---|
| Snapshot schedules by API (`volumeInstanceBackupScheduleUpdate`, spec §3.3 step 7) | **#756** (Pro workspace) | Hobby refuses (`maxBackupsCount: 0`) |
| A workspace token's exact powers (creating projects in its workspace, no reach outside it) | **#756** | No workspace token exists yet; the spike used an account session. Railway's docs say a workspace token reaches only its own workspace's resources |
| Pro limits and rate limits as the API reports them | **#756** | Read from Hobby only; the Pro numbers above are from the docs |
| Latency and redeploy timings in the boxes' own region and plan | **#756** | Re-run §3.4 and §4 in `agentdash-boxes` once it exists; expect the same shape |
| Wildcard certificate issuance and its time, `*.agentdash.cloud` resolving to the router | **#758** (GoDaddy records) | Needs the three records in place |
| A real box's redeploy outage including AgentDash's boot | #732 and SC-2 | Needs the GHCR image and the real variable set; timed as part of SC-2's acceptance |

## 8. Corrections to the design (PR #755)

The design is still on its PR branch, so these are recorded here rather than edited into it; the same list is posted on #755.

1. **§3.3 step 3: confirmed, with detail.** Postgres from `ghcr.io/railwayapp-templates/postgres-ssl:<major>` with its own volume and an in-memory password works by API alone. Pin the major (the template now defaults to 18). Set the image last; that update deploys by itself.
2. **§4.1:** the `_acme-challenge` CNAME target is `<id>.authorize.railwaydns.net`, printed per domain, and the TXT host is `_railway-verify`.
3. **§4.3:** Railway's edge overwrites `X-Forwarded-Host`, `X-Forwarded-For` and `X-Real-IP` on the hop into the box. The router must not rely on them; it sends the client IP in `X-AgentDash-Client-IP` (overwriting any client copy) and, if the public name is ever needed, a custom header.
4. **§4.4: confirmed.** The box must take its public URL from `PAPERCLIP_PUBLIC_URL`, not from forwarded headers, and must trust `X-AgentDash-Client-IP` only with a matching edge secret, because Railway passes custom headers from any caller who uses the Railway host directly.
5. **§4.5:** the router hop adds about 25 ms at p50 (measured), not 5 to 20 ms.
6. **§6.1:** the platform's part of a Volume redeploy outage is 5 to 7 s; the rest is the box's boot.

## Sources

- Railway GraphQL schema, introspected anonymously from `https://backboard.railway.com/graphql/v2` on 2026-09-25
- Railway's Postgres template config: `template(code: "postgres") { serializedConfig }`
- [Working with Domains](https://docs.railway.com/networking/domains/working-with-domains): wildcard records, limits per plan, issuance within an hour
- [Public networking specs and limits](https://docs.railway.com/networking/public-networking/specs-and-limits): HTTP duration limits, WebSocket exemption, headers Railway sets
- [Public API](https://docs.railway.com/integrations/api): token types and rate limits per plan
