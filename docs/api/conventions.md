---
title: Conventions
summary: Ids, request and error format, visibility, pagination and rate limits — as the server implements them.
---

What holds for the whole API. Each section names the file it was read from; where a number is given, it is the server's default, read from that file, and an instance's operator can change some of them.

## Requests and responses

- Bodies are JSON: send `Content-Type: application/json`. The server accepts bodies up to 10 MB (`server/src/app.ts`).
- A success returns the resource itself, or an array of them — there is no envelope. Creating something answers 201.
- A known route called with the wrong method answers **405** with an `Allow` header. An unknown path under `/api` answers 404 `API route not found` (`server/src/middleware/method-not-allowed.ts`).

## Ids

- Every id is a **UUID** in its canonical, hyphenated form.
- Issues also accept their identifier wherever an issue id goes in a path: `/api/issues/ENG-12` is the same issue as `/api/issues/<its uuid>`.
- An id that is not a UUID answers **400** `{ "error": "Invalid identifier" }` when it reaches the database (`server/src/middleware/error-handler.ts`). Some routes check first and answer 400 with a more specific message, such as `reviewerAgentId must be a UUID`. Visibility guards answer 404 for any non-canonical form, the same as for an id that does not exist.

## Errors

Every error is JSON with a human-readable `error`:

```json
{ "error": "Issue not found" }
```

A body that fails its schema answers 400 with the failing fields:

```json
{ "error": "Validation error", "details": [{ "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["title"], "message": "Required" }] }
```

A body that is not JSON at all answers **500** `Internal server error` today, not 400: the JSON body parser's error reaches the error handler unmapped (`server/src/middleware/error-handler.ts`). This is filed as a server bug; do not rely on the 500.

Some errors add `details` or a machine-readable `code`. Match on the status code, then on `code` where one is documented; the `error` text is for people and may change.

| Status | Means |
| --- | --- |
| 400 | Malformed: an invalid id, a body that fails validation, a bad query parameter. |
| 401 | No credential the server could resolve. See [Authentication](/api/authentication). |
| 403 | You are known and may not do this — including any company-scoped route for a company you are not a member of. |
| 404 | Not found, **or not visible to you**. See below. |
| 405 | The route exists; the method does not. |
| 409 | The resource is not in a state that allows this — for example, an issue checked out by another agent. Do not retry blindly. |
| 422 | Well-formed, but the server will not do it. |
| 429 | Rate limited. See below. |
| 500 | A server fault. It is recorded; `{ "error": "Internal server error" }` is all the response says. |
| 503 | A dependency is not configured or not reachable. `GET /api/health` answers 503 when the server is up but unhealthy. |

## Visibility: 404, never 403

Inside a company you belong to, some things are not visible to everyone — a restricted project, the issues in it, an agent whose visibility is restricted. For those, the server answers **404**, exactly as if the thing did not exist. It never answers 403: a 403 on a guessed id would confirm that the id is real, which is itself the leak (`server/src/routes/visibility.ts`). Lists leave invisible rows out rather than redacting them, and references to them inside visible rows are removed.

So a 404 means "not found, or not yours to see", and the API will not tell you which. Company membership is different: a company you are not a member of answers 403 on its company-scoped routes, because which companies exist is not what visibility protects.

## Pagination

There is no general pagination scheme. As implemented:

- **Most list routes return the whole list** as one array, with no paging parameters.
- **A few take `limit` and `offset`.** Issues (`GET /api/companies/{companyId}/issues`): `limit` defaults to 500, values above 1000 are treated as 1000, and a limit of 0 or a non-integer answers 400; `offset` defaults to 0 (`server/src/services/issues.ts`). An issue's runs (`GET /api/issues/{id}/runs`): default 100, at most 500.
- **The activity log takes `limit` and `since`.** `limit` defaults to 100 and is clamped to 1–500; `since` is an ISO 8601 timestamp and returns rows at or after it (`server/src/services/activity.ts`).
- **There are no cursors and no total counts.** Page with `offset`; a page shorter than `limit` is the last one.

Each operation's parameters are in [the API reference](/api/reference).

## Rate limits

Measured from `server/src/middleware/rate-limit.ts`, which uses fixed 15-minute windows. Defaults, per window:

| Applies to | Limit | Counted per |
| --- | --- | --- |
| State-changing requests under `/api` | 200 | actor |
| Sign-in and auth routes under `/api/auth`, and redeeming a connect code | 10 | actor |
| Billing | 20 | actor |
| Sending invites | 20 | actor |
| Filing a bug report | 10 | actor |
| The anonymous trial | 30 | IP address |
| OAuth: metadata 200 · authorize 100 · consent 120 · register 30 · token 60 · revoke 60 | as listed | actor; the token endpoint per client and IP |

- **Reads are not counted** for an authenticated caller: `GET` and `HEAD` with a valid credential skip the default limit. Unauthenticated reads are counted. `GET /api/health` is never limited, and an enrolled machine's `POST /api/bridge/poll` is not counted.
- **"Actor"** means the signed-in person or the agent; with no credential, the IP address.
- A limited request answers **429** with `Retry-After: 900`, the draft-7 `RateLimit` headers, and `{ "error": "Rate limited", "retryAfter": 900 }`.
- Rate limiting is off on an instance running in `local_trusted` mode. An operator can change each limit, or turn them off.
- Assistant grants also have their own write budget: 30 writes and 10 new tasks an hour per grant, answered with 429 and `Retry-After` when spent ([Authentication](/api/authentication)).

These are what the code does today, not a promise: limits may change between releases.
