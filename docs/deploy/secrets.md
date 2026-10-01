---
title: Secrets
summary: How a self-hosted instance encrypts secrets, where the master key lives, and strict mode
---

AgentDash stores secrets (API keys, tokens) encrypted in the database. Agent and project environment variables can point at a stored secret instead of holding the value inline. The server decrypts it when it needs the value, for example when it starts an agent run, and injects it into that process's environment.

To create and rotate secrets through the API, see [Secrets API](/api/secrets).

## Provider: `local_encrypted`

`local_encrypted` is the only provider that works today. Secrets are encrypted with AES-256-GCM using a 32-byte master key. Source: `server/src/secrets/local-encrypted-provider.ts`.

The provider list also names `aws_secrets_manager`, `gcp_secret_manager` and `vault`. They are stubs: any attempt to store or read through them fails with "provider is not configured in this deployment". Source: `server/src/secrets/external-stub-providers.ts`.

## The master key

The server looks for the key in this order:

1. `PAPERCLIP_SECRETS_MASTER_KEY`: the key itself, as 32-byte base64, 64-character hex, or a raw 32-character string.
2. The key file at `PAPERCLIP_SECRETS_MASTER_KEY_FILE`, else the instance config's key path, else `~/.paperclip/instances/default/secrets/master.key`.
3. If neither exists, it generates a random key and writes it to that file with mode `600`.

Back up the key. Without it, stored secrets cannot be decrypted. It is not in the database, so a database backup does not contain it.

## Configuration

From a clone, with the repository CLI:

```sh
pnpm paperclipai configure --section secrets   # change provider, key file or strict mode
pnpm paperclipai doctor                         # check the secrets configuration
```

Or with environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PAPERCLIP_SECRETS_PROVIDER` | `local_encrypted` | Provider for new secrets |
| `PAPERCLIP_SECRETS_MASTER_KEY` | (unset) | The key itself |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `<instance>/secrets/master.key` | Key file path |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Reject inline values for sensitive keys |

## Strict mode

With `PAPERCLIP_SECRETS_STRICT_MODE=true`, an environment binding whose key looks sensitive must be a secret reference. A plain value is rejected with "Strict secret mode requires secret references for sensitive key". A key counts as sensitive when its name contains, ignoring case, any of: `api_key` / `apikey`, `access_token`, `auth`, `authorization`, `bearer`, `secret`, `passwd`, `password`, `credential`, `jwt`, `private_key`, `cookie`, `connectionstring`. Source: `server/src/services/secrets.ts`.

Turn it on for any instance other people use.

## Secret references

An environment binding is either a plain value or a reference:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "8f884973-c29b-44e4-8ea3-6413437f8081",
      "version": "latest"
    }
  }
}
```

`version` is `"latest"` or a version number, and may be left out. A plain value can be a bare string or `{ "type": "plain", "value": "..." }`. Source: `packages/shared/src/validators/secret.ts`.

## Moving inline values into secrets

If agents already hold API keys inline, convert them to secret references from a clone. The script reads every agent's adapter `env`, and turns each non-empty plain value under a sensitive-looking key into a stored secret. It needs `DATABASE_URL`; for the embedded database that is `postgres://paperclip:paperclip@127.0.0.1:54329/paperclip` while the server runs (adjust the port if it moved).

```sh
pnpm secrets:migrate-inline-env           # dry run
pnpm secrets:migrate-inline-env --apply   # write the secrets and update the agents
```

Source: `scripts/migrate-inline-env-secrets.ts`.
