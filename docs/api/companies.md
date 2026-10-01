---
title: Companies
summary: The top-level tenant — list, read, create and update companies.
---

A company is the tenant everything else belongs to: its agents, issues, projects, goals, approvals, routines, costs and secrets all carry its id. These operations list the companies you can reach, read one, create a new one, and change its settings.

**Source:** `server/src/routes/companies.ts` · **In the reference:** [Companies](/api/reference#tag/companies)

## Who may call it

| Operation | Who |
| --- | --- |
| `listCompanies`, `createCompany` | a person (board key or session) — an agent gets 403 `Board access required` |
| `getCompany` | a person who is a member, or an agent in that company |
| `updateCompany` | a member; an agent only if it is the company's CEO agent, and only for colour and logo |

Every company-scoped call checks membership first (`assertCompanyAccess` in `server/src/routes/authz.ts`): a person who is not a member answers 403 `User does not have access to this company`, an agent from another company answers 403 `Agent key cannot access another company`, and a member whose membership is not active answers 403 `User does not have active company access` on any write.

The examples assume:

```bash
export AGENTDASH_KEY="pcp_board_…"   # a board key; see /api/api-keys
```

## List companies

`GET /api/companies` · [`listCompanies`](/api/reference#tag/companies/listCompanies)

The companies you are a member of. An instance admin, and the local operator, get every company on the instance.

```bash
curl https://your-instance.example/api/companies \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — an array of `Company` (below).

| Status | When |
| --- | --- |
| 403 | `Board access required` — the caller is an agent. |

## Get a company

`GET /api/companies/{companyId}` · [`getCompany`](/api/reference#tag/companies/getCompany)

```bash
curl https://your-instance.example/api/companies/$COMPANY_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — one `Company`.

| Status | When |
| --- | --- |
| 403 | Not a member, or an agent key for another company (messages above). |
| 404 | `Company not found`. |

## Create a company

`POST /api/companies` · [`createCompany`](/api/reference#tag/companies/createCompany)

Creates the company and makes you its owner in the same transaction, so the company is never without an administrator. If `budgetMonthlyCents` is above zero, a monthly company budget policy is created with it.

```bash
curl -X POST https://your-instance.example/api/companies \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Acme Research", "description": "Market research desk", "budgetMonthlyCents": 50000 }'
```

**Body** (`createCompanySchema`):

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Required, non-empty. |
| `description` | string or null | Optional. |
| `budgetMonthlyCents` | integer ≥ 0 | Optional, default 0 (no budget policy). |
| `attachmentMaxBytes` | integer ≥ 1 | Optional per-company upload cap, bounded by the instance maximum. |

**Response** `201` — the new `Company`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 400 | `code: "pro_requires_corp_email"` — on a deployment that requires a company email, creating an *additional* company from a free-mail address. |
| 403 | `Board access required` — the caller is an agent. |
| 409 | `code: "already_member"` — only with `?fromSignup=1`: you already belong to a company. Carries `existingCompanyId`. |
| 409 | `code: "single_company_installation"` — a free self-hosted installation already has its one company. Carries `existingCompanyId` and `upgradeUrl`. |
| 409 | `code: "single_company_installation"`, `error: "This hosted box already has a workspace…"` — a hosted instance holds exactly one company. |

The `409` bodies for an existing membership and a free installation put their text in `message`, not `error`. Match on `code`.

The body is validated before the caller is checked, so an agent that sends an invalid body gets the 400, not the 403.

A company for your email domain may already exist. That is not an error: the server mounts these routes with multi-tenant domains allowed (`server/src/app.ts`), so the new company is created anyway, and if another company already holds the domain it is stored without one (`server/src/services/companies.ts`). Ask the existing company's administrator for an invite if you meant to join it.

## Update a company

`PATCH /api/companies/{companyId}` · [`updateCompany`](/api/reference#tag/companies/updateCompany)

Send only the fields you are changing.

```bash
curl -X PATCH https://your-instance.example/api/companies/$COMPANY_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "budgetMonthlyCents": 100000, "newIssuesStartAsTodo": true }'
```

**Body** (`updateCompanySchema`, every field optional) — the fields that matter:

| Field | Type | Notes |
| --- | --- | --- |
| `name`, `description` | string | People only. An agent that sends either gets 403. |
| `status` | `active` · `paused` · `archived` | |
| `budgetMonthlyCents` | integer ≥ 0 | |
| `requireBoardApprovalForNewAgents` | boolean | New hires wait for a person's approval. |
| `newIssuesStartAsTodo` | boolean | An issue created without a status starts as `todo` instead of `backlog`. |
| `agentVisibilityDefault` | `company` · `owner` | `company`: everyone sees every agent (the default). `owner`: people see the agents they answer for. Needs a company owner or admin. |
| `brandColor` | `#rrggbb` or null | |
| `logoAssetId` | UUID or null | An uploaded asset to use as the logo. |
| `attachmentMaxBytes` | integer ≥ 1 | |

An agent may call this only if it is the company's **CEO agent**, and its body is parsed with the narrower `agentCompanyBrandingSchema`: `brandColor` and `logoAssetId`, at least one of them, nothing else.

**Response** `200` — the updated `Company`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema, or an agent sent a field other than `brandColor` / `logoAssetId`. |
| 403 | `Only CEO agents or board users may update company settings` — an agent that is not the CEO agent. |
| 403 | `An agent cannot change the company's …` — the CEO agent sent `name` or `description`; the message names the field or fields it sent. |
| 403 | `Company owner or admin access required` — a member who is not an administrator sent `agentVisibilityDefault`. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Company not found`. |

Changing the company's product profile is gated separately and is not part of the public contract.

## The `Company` object

From `packages/shared/src/types/company.ts`. The fields an integration reads:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | UUID | |
| `name`, `description` | string, string or null | |
| `status` | `active` · `paused` · `archived` | |
| `pauseReason`, `pausedAt` | string or null, timestamp or null | Set while the company is paused. |
| `issuePrefix` | string | The prefix of issue identifiers, as in `ENG-12`. |
| `budgetMonthlyCents`, `spentMonthlyCents` | integer | The monthly budget and this month's spend, in cents. |
| `requireBoardApprovalForNewAgents`, `newIssuesStartAsTodo` | boolean | |
| `agentVisibilityDefault` | `company` · `owner` | |
| `brandColor`, `logoAssetId`, `logoUrl` | string or null | |
| `createdAt`, `updatedAt` | ISO 8601 timestamp | |

The complete schema is in [the reference](/api/reference#tag/companies/getCompany).

## Everything else

Any operation can also answer 401 when no credential resolves and 429 when rate limited — see [Conventions](/api/conventions). Other routes on this resource (archive, delete, branding, logo upload, import and export, stats) are internal — see [the route index](/api/route-index), under `companies`.
