---
title: Secrets
summary: Store a company secret, list secrets by name, and rotate a value. Values are never returned.
---

A secret is a named value, such as an API key, that agents use without it ever appearing in their configuration. You store the value once; agent configuration refers to the secret by id, and the server puts the value into the agent's environment when a run starts.

**Source:** `server/src/routes/secrets.ts` · **In the reference:** [Secrets](/api/reference#tag/secrets)

**No operation on this page returns a secret's value.** Listing, creating and rotating all answer with metadata only: the name, the provider, the latest version number. The value is stored apart from that metadata, and the server decrypts it only for its own use, such as starting a run.

## Who may call it

| Operation | Who |
| --- | --- |
| `listSecrets`, `createSecret`, `rotateSecret` | a person (board key or session) who is a member of the company — an agent gets 403 `Board access required` |
| `rotateSecret` on a secret owned by a connection | a company owner or admin |

Every call checks membership after the board check (`assertCompanyAccess` in `server/src/routes/authz.ts`): a person who is not a member answers 403 `User does not have access to this company`, and a member whose membership is not active answers 403 `User does not have active company access` on a create or a rotate.

Some secrets belong to a connection, such as a GitHub connection's token. They are not listed, their names (`github-token-…`) are reserved, and only an owner or admin may rotate one (`server/src/services/secrets.ts`).

The examples assume:

```bash
export AGENTDASH_KEY="pcp_board_…"   # a board key; see /api/api-keys
```

## List secrets

`GET /api/companies/{companyId}/secrets` · [`listSecrets`](/api/reference#tag/secrets/listSecrets)

The company's secrets, newest first, without connection-owned ones.

```bash
curl https://your-instance.example/api/companies/$COMPANY_ID/secrets \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — an array of `CompanySecret` (below).

| Status | When |
| --- | --- |
| 403 | `Board access required` — the caller is an agent. |
| 403 | Not a member (message above). |

## Create a secret

`POST /api/companies/{companyId}/secrets` · [`createSecret`](/api/reference#tag/secrets/createSecret)

Stores the value as version 1. The response does not include it.

```bash
curl -X POST https://your-instance.example/api/companies/$COMPANY_ID/secrets \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "research-api-key", "value": "'"$SECRET_VALUE"'", "description": "Key for the research data feed" }'
```

**Body** (`createSecretSchema`):

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Required, non-empty, unique in the company. A name starting `github-token-` (any case) is reserved. |
| `value` | string | Required, non-empty. Never returned. |
| `provider` | `local_encrypted` · `aws_secrets_manager` · `gcp_secret_manager` · `vault` | Optional. Defaults to the instance's configured provider, which is `local_encrypted` unless the operator set another. |
| `description` | string or null | Optional. |
| `externalRef` | string or null | Optional. Ignored by `local_encrypted`, which stores `null`. |

**Use `local_encrypted`.** It encrypts the value with AES-256-GCM under the instance's master key (`server/src/secrets/local-encrypted-provider.ts`). The other three providers are listed but not implemented: creating a secret with one answers 422 (`server/src/secrets/external-stub-providers.ts`).

**Response** `201` — the new `CompanySecret`, with `latestVersion: 1`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema, or `provider` is not one of the four. |
| 403 | `Board access required` — the caller is an agent. The body is validated first, so an agent that sends an invalid body gets the 400 instead. |
| 403 | Not a member, or an inactive membership (messages above). |
| 409 | `Secret already exists: <name>` — the company already has a secret with this name. |
| 422 | `Secret names starting with github-token- are reserved for connections.` |
| 422 | `<provider> provider is not configured in this deployment` — `aws_secrets_manager`, `gcp_secret_manager` or `vault`. |

## Rotate a secret

`POST /api/secrets/{id}/rotate` · [`rotateSecret`](/api/reference#tag/secrets/rotateSecret)

Stores a new value as the next version and makes it the latest. Earlier versions are kept. An agent whose configuration refers to the secret at version `latest` gets the new value on its next run; one pinned to a version number keeps that version.

```bash
curl -X POST https://your-instance.example/api/secrets/$SECRET_ID/rotate \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "value": "'"$NEW_SECRET_VALUE"'" }'
```

**Body** (`rotateSecretSchema`):

| Field | Type | Notes |
| --- | --- | --- |
| `value` | string | Required, non-empty. Never returned. |
| `externalRef` | string or null | Optional. Ignored by `local_encrypted`. |

**Response** `200` — the updated `CompanySecret`; `latestVersion` is one higher.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 403 | `Board access required` — the caller is an agent. The body is validated first, so an agent that sends an invalid body gets the 400 instead. |
| 403 | `This secret belongs to a connection (for example GitHub). Only a workspace owner or admin can change it…` — a member who is not an owner or admin, on a connection-owned secret. |
| 403 | Not a member of the secret's company, or an inactive membership (messages above). |
| 404 | `Secret not found`. |

## Using a secret in agent configuration

Refer to the secret by id in the `env` of an agent's adapter configuration, instead of putting the value there (`envBindingSecretRefSchema` in `packages/shared/src/validators/secret.ts`):

```json
{
  "env": {
    "RESEARCH_API_KEY": { "type": "secret_ref", "secretId": "<the secret's id>", "version": "latest" }
  }
}
```

`version` is `latest` or a positive integer, and defaults to `latest`. The secret must be in the agent's company, and a connection-owned secret cannot be bound. See [Agents](/api/agents).

## The `CompanySecret` object

From `packages/shared/src/types/secrets.ts`. It has no value field. The fields an integration reads:

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `companyId` | UUID | |
| `name` | string | |
| `provider` | `local_encrypted` · `aws_secrets_manager` · `gcp_secret_manager` · `vault` | |
| `latestVersion` | integer | Starts at 1; each rotation adds one. |
| `description`, `externalRef` | string or null | |
| `createdByUserId` | string or null | |
| `createdByAgentId` | UUID or null | |
| `createdAt`, `updatedAt` | ISO 8601 timestamp | |

The complete schema is in [the reference](/api/reference#tag/secrets/listSecrets).

## Everything else

Any operation can also answer 401 when no credential resolves and 429 when rate limited — see [Conventions](/api/conventions). Other routes on this resource (the provider list, renaming, deleting) are internal — see [the route index](/api/route-index), under `secrets`.
