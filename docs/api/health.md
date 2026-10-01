---
title: Health
summary: Is the server up, which version is it, and are any of its checks degraded.
---

`GET /api/health` tells a load balancer, an install script or a monitor whether the server is answering and whether it can reach its database. It also reports the server version and a few checks that can go degraded: disk space, backup age and stuck runs.

**Source:** `server/src/routes/health.ts` · **In the reference:** [Health](/api/reference#tag/health)

## Who may call it

| Operation | Who |
| --- | --- |
| `getHealth` | anyone — no credential needed |

What you get back depends on the instance's deployment mode and on who you are (`shouldExposeFullHealthDetails` in `server/src/routes/health.ts`):

- On an instance in `authenticated` mode, a request with no credential, or one that does not resolve, gets the **short** response.
- On an instance in `authenticated` mode, a person or an agent gets the **full** response.
- On an instance in `local_trusted` mode, every caller gets the **full** response.

The route is mounted ahead of the license check, and it is never rate limited (`server/src/middleware/rate-limit.ts`).

## Check health

`GET /api/health` · [`getHealth`](/api/reference#tag/health/getHealth)

```bash
curl https://your-instance.example/api/health
```

The server first probes its database and runs its checks (`computeHealthChecks` in `server/src/observability/health-checks.ts`). If that probe fails, it answers 503 at once.

**Response** `200` — the server is up and reached its database. Read `status`: `ok`, or `degraded` when a check below failed. A degraded server still answers 200.

An abbreviated short response:

```json
{ "status": "ok", "version": "<server version>", "deploymentMode": "authenticated", "bootstrapStatus": "ready" }
```

**Response** `503` — the server is up, but the probe failed:

```json
{ "status": "unhealthy", "version": "<server version>", "error": "database_unreachable" }
```

| Status | When |
| --- | --- |
| 503 | `error: "database_unreachable"` — the database did not answer, or another check in the probe threw. `status` is `unhealthy`. |

To decide whether an instance is usable, treat 503 as down, and `status: "degraded"` as up but needing attention.

## The response

Both `200` shapes carry these fields. The `503` body carries only `status`, `version`, `error` and the release fields.

| Field | Type | Notes |
| --- | --- | --- |
| `status` | `ok` · `degraded` · `unhealthy` | `unhealthy` only with 503. |
| `version` | string | The server version, from the server package. |
| `releaseTag`, `releaseCommit` | string | Present only when the operator set a release tag, or the process runs from an installed release. |
| `deploymentMode` | `local_trusted` · `authenticated` | |
| `bootstrapStatus` | `ready` · `bootstrap_pending` | `bootstrap_pending`: an `authenticated` instance with no instance admin yet. Always `ready` in `local_trusted` mode. |
| `bootstrapInviteActive` | boolean | While bootstrap is pending, whether an unexpired first-admin invite exists. |
| `instanceHasCompany` | boolean | Whether the instance has any company that is not archived. |
| `adapterReady`, `adapterPreset` | boolean, string | Whether the instance's default model adapter is configured. |
| `publicBaseUrl`, `canonicalOrigin` | string | Present only when the operator set a public base URL. |

The **full** response adds the individual checks:

| Field | Type | Notes |
| --- | --- | --- |
| `db` | `{ ok, latencyMs }` | Time taken by the database probe. |
| `disk` | `{ ok, freeBytes }` | `ok` is false at 5 GiB free or less. |
| `backup` | `{ ok, latestAt, ageHours }` or null | `ok` is false when the newest backup is 26 hours old or older, or there is none. `null` where the instance keeps no backup directory, which does not make it degraded. |
| `runs` | `{ ok, stuck }` | `stuck` counts runs queued or running that have not been updated in the last 2 hours. `ok` is false when it is above 0. |
| `deploymentExposure` | `private` · `public` | |
| `authReady` | boolean | |
| `adapterReason` | string or null | Why the adapter is not ready. |
| `features` | object | Instance feature switches, such as `companyDeletionEnabled`. |

The thresholds (5 GiB, 26 hours, 2 hours) are the defaults in `server/src/observability/health-checks.ts`. `status` is `degraded` when `disk`, `runs` or a present `backup` is not `ok`.

## Everything else

This route takes no credential, so it does not answer 401, and it is exempt from rate limiting — see [Conventions](/api/conventions). There are no other routes on this resource; see [the route index](/api/route-index), under `health`.
