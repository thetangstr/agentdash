# Attestation v2a — Agent Identity + Delegation Certificates

**Status:** Draft (scope locked, implementation gated)
**Date:** 2026-05-14
**Builds on:** [v1 design](2026-05-13-delegation-and-attestation-design.md) (audit trail anchoring, shipped in [agentdash#289](https://github.com/thetangstr/agentdash/pull/289))
**Author:** AgentDash team

## Why

v1 anchors the audit trail. v2a makes every action *attributable*. After this lands, every `activity_log` row carries a cryptographic signature from the acting agent and an optional reference to a signed delegation certificate, so the trail anchors **signed claims**, not opaque payloads.

This unblocks two product claims we cannot make today:

- *"Every action in your AgentDash workspace is signed by a key bound to a delegation cert your principal authorized."*
- *"Anyone with a copy of the trail + our public keys can prove which agent took which action, when, under whose authority - without trusting AgentDash."*

It also pre-positions us against the three standards the rest of the industry is racing on:

| Standard | What v2a delivers |
|---|---|
| **W3C DIDs** | Per-agent Ed25519 keypair becomes the DID's `verificationMethod`. Public key URL is the resolver. |
| **AIP delegation chains** | `delegations.parent_delegation_id` is the chain. Cert payload aligns with [draft-singla-agent-identity-protocol-00](https://datatracker.ietf.org/doc/draft-singla-agent-identity-protocol/00/). |
| **A2A AgentCard** | Building blocks for `AgentCard` (handle + pubkey + supported auth schemes) all land here. Endpoint deferred to v2c. |
| **WIMSE / SPIFFE** | Out of scope. Adapter gated on customer demand. |

## Non-goals (v2a)

- **Boundary enforcement** — actions can still be logged without a delegation cert in v2a. Hard 403 on missing/expired/out-of-scope certs is deferred to **v2b** so we can roll out signing progressively without breaking existing flows.
- **Cert revocation** — v2b.
- **Cert UI** — v2a ships API endpoints only. Browser-side WebCrypto signing UX is v2b.
- **ANS DNS naming** — v2c.
- **A2A AgentCard endpoint** — v2c.
- **Cross-org capability tokens** — v3.
- **WIMSE / SPIFFE adapter** — gated on customer demand.

## Architecture

```
                                    ┌──────────────────┐
                                    │ agent_keys       │  (NEW)
                                    │  agent_id        │
                                    │  public_key      │
                                    │  algorithm       │
                                    │  kms_key_ref     │
                                    │  revoked_at      │
                                    └──────────────────┘
                                              │  binds key to
                                              ▼
┌──────────────────┐  signed by       ┌──────────────────┐
│ delegations      │ ───────────────► │ agents           │
│  (NEW)           │                  │  (existing)      │
│  principal_user  │                  └──────────────────┘
│  agent_id        │                            │
│  scopes[]        │                            │ signs each action
│  purpose         │                            ▼
│  not_before/_after│                ┌──────────────────┐
│  parent_id       │                 │ activity_log     │
│  signature       │                 │  + signature      │  (cols ADDED)
│  signer_pubkey   │                 │  + delegation_id  │
└──────────────────┘                 │  + public_key_id  │
                                     │  + envelope_v     │
                                     └──────────────────┘
                                              │ hashed + anchored
                                              ▼
                                    ┌──────────────────┐
                                    │ trail_anchors    │  (v1, unchanged)
                                    └──────────────────┘
```

## Component 1: Per-agent keypair + key registry

### Data model

New table `agent_keys`:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `agent_id` | `uuid` FK | |
| `algorithm` | `text` | `"ed25519"` for v2a |
| `public_key` | `text` | Base64-encoded raw public key |
| `kms_key_ref` | `text` nullable | Opaque ID into the KMS adapter; null if held in-process |
| `created_at` | `timestamptz` | |
| `revoked_at` | `timestamptz` nullable | Soft revoke; `null` means active |

Constraint: at most one active (`revoked_at IS NULL`) key per `agent_id` at a time.

### Lifecycle

1. On agent creation, generate Ed25519 keypair via libsodium.
2. Private key handling sits behind a `KeyStore` interface with two implementations:
   - `LocalKeyStore` (v2a default) - libsodium in-process, key material persisted encrypted at rest using the existing `companySecrets` envelope encryption pattern.
   - `KmsKeyStore` (v2b) - AWS KMS, GCP KMS, or HashiCorp Vault. Same interface, no service-side code change.
3. Public key persisted to `agent_keys`. Served via `GET /api/agents/:id/public-key` (unauthenticated, public-by-design).
4. Rotation: new row in `agent_keys` with `revoked_at = NULL`; old row's `revoked_at` set to `now()`. Activity log entries reference the `public_key_id` they were signed against, so old signatures stay verifiable.
5. Revocation: set `revoked_at`. Future signatures fail; past signatures remain verifiable as historical attestations.

### Why Ed25519

- 64-byte signatures, ~0.1ms sign latency, audited libsodium implementation, native Node `crypto.sign` support.
- Wide DID support (`Ed25519Signature2020`, `Ed25519VerificationKey2020`).
- Compatible with both [draft-singla-agent-identity-protocol-00](https://datatracker.ietf.org/doc/draft-singla-agent-identity-protocol/00/) and the W3C DID core.

## Component 2: Signed action envelope

### Canonical envelope

```typescript
interface ActionEnvelopeV1 {
  v: 1;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  detailsHash: string;        // SHA-256(canonicalJson(details))
  delegationId: string | null; // null permitted in v2a; required for agent actors in v2b
  systemTime: string;          // ISO-8601, ms precision
  prevHash: string | null;     // optional chain hint
}
```

`signatureBytes = ed25519_sign(privKey, sha256(canonicalJson(envelope)))`

### Flow

1. `logActivity(input)` builds the envelope.
2. For `actorType="agent"`, look up the active key in `agent_keys`. Sign.
3. Insert `activity_log` with new columns:
   - `envelope_v` integer (always `1` in v2a)
   - `public_key_id` uuid nullable (FK to `agent_keys.id`)
   - `signature` text nullable (base64)
   - `delegation_id` uuid nullable (FK to `delegations.id`)
4. For non-agent actors (`user`, `system`, `plugin`), columns stay null. The trail manifest still hashes the row deterministically.

### Backfill

None. Old `activity_log` rows have NULL signatures forever. The verifier distinguishes "pre-v2a, unsigned" from "signed and broken" via `envelope_v`. Anchors covering pre-v2a rows verify integrity (hash chain) but not authorship - which is the historically correct claim.

## Component 3: Delegation certificates

### Data model

New table `delegations`:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `company_id` | `uuid` FK | Per-company scoping |
| `principal_actor_type` | `text` | `"user"` or `"agent"` |
| `principal_actor_id` | `text` | User id or agent uuid |
| `principal_public_key_id` | `uuid` nullable | The key that signed THIS cert |
| `agent_id` | `uuid` FK | Recipient of the delegation |
| `agent_public_key_id` | `uuid` FK | Key the cert binds to (locks the cert to a specific keypair) |
| `scopes` | `text[]` | List of scope strings (see vocabulary below) |
| `purpose` | `text` | Free-form, displayed to humans during review |
| `not_before` | `timestamptz` | |
| `not_after` | `timestamptz` | |
| `parent_delegation_id` | `uuid` FK self | For sub-delegations from CoS to workers; null for root certs |
| `signature` | `text` | Ed25519 sig over canonical(cert payload) |
| `revoked_at` | `timestamptz` nullable | v2b adds revocation flow; column reserved here |
| `created_at` | `timestamptz` | |

### Cert payload (the bytes that get signed)

```json
{
  "v": 1,
  "id": "del_0xab12...",
  "companyId": "co_...",
  "principal": {
    "type": "user",
    "id": "user_...",
    "publicKeyId": "key_..."
  },
  "agent": {
    "id": "agent_...",
    "publicKeyId": "key_..."
  },
  "scopes": ["task.create", "issue.comment"],
  "purpose": "Renew Datadog 2026 contract at or under $180K/yr",
  "notBefore": "2026-05-14T00:00:00Z",
  "notAfter": "2026-06-30T00:00:00Z",
  "parentDelegationId": null,
  "issuedAt": "2026-05-14T12:00:00Z"
}
```

### Scope vocabulary (v2a starter)

Scopes are dotted strings. Wildcards explicitly disallowed in v2a.

| Scope | Allows |
|---|---|
| `task.create` | Create issues, tasks |
| `task.update` | Update task state |
| `task.delete` | Delete tasks |
| `issue.comment` | Post comments |
| `approval.request` | Request approvals |
| `file.read` | Read company files |
| `file.write` | Write files |
| `agent.spawn` | CoS only - spawn worker agents |
| `agent.delegate` | CoS only - mint sub-delegations |

Scope strings are extensible. Add via PR; do not hardcode an enum.

### Issuance flow

Three actors can mint certs:

1. **A human user** - signs in browser via WebCrypto with a session-derived key. For v2a, the signing-key UX is API-only (`POST /api/companies/:companyId/delegations` with a signed payload). Browser-side UI ships in **v2b**.
2. **A CoS agent** (`role='chief_of_staff'`) - mints sub-certs to worker agents. Server-side validator enforces:
   - `scopes` ⊆ parent cert's `scopes`
   - `not_after` ≤ parent cert's `not_after`
   - `parent_delegation_id` references an active (non-revoked, in-window) cert
3. **A system actor** - for bootstrap (initial agent creation, internal services).

### API surface (v2a)

| Method + path | Purpose |
|---|---|
| `POST /api/companies/:companyId/delegations` | Accepts signed cert payload, validates signature against `principal.publicKeyId`, persists. Returns the row. |
| `GET /api/companies/:companyId/delegations/:id` | Returns the cert. |
| `GET /api/companies/:companyId/agents/:agentId/delegations` | List active certs for an agent. |
| `GET /api/agents/:id/public-key` | Public, unauthenticated. Returns the agent's active public key. |

No revocation, no listing-by-principal, no UI. Those are v2b.

## End-to-end verification

Given a `trail_anchor` row plus the `activity_log` rows it covers plus `agent_keys` plus `delegations`:

1. Reconstruct the manifest from the row range. Hash → check `trail_anchor.manifest_sha256`. (v1 verifier)
2. Verify the external anchor (Clockchain `log_id` matches our hash on-chain). (v1 verifier)
3. For each row in the window where `envelope_v IS NOT NULL`:
   - Reconstruct the envelope from columns + `detailsHash`.
   - Look up `agent_keys` by `public_key_id`. Note `revoked_at`.
   - Verify `signature` over `sha256(canonicalJson(envelope))` against `public_key`.
   - If `delegation_id` is present, verify the delegation cert separately: signature, time window, scope match.
4. Return `{ ok, mismatches, anchorVerified, signaturesVerified, delegationsVerified }`.

The verifier is a pure function over read-only inputs. Suitable for the CLI (`agentdash verify-trail`) and for third-party audit tools.

## Rollout

| Step | Risk |
|---|---|
| Schema migration: new tables (`agent_keys`, `delegations`) + nullable columns on `activity_log` | Low - additive only |
| Ship signing code behind `AGENTDASH_SIGNED_ACTIONS_ENABLED` flag | Low - flag off = current behavior |
| Generate keys for new agents at creation time | Low - keys are cheap, libsodium is fast |
| Retro-generate keys for existing agents (one-time backfill) | Medium - touches every agent row; gated, idempotent |
| Flip flag in dev → staging → first pilot prod company | Medium - gives us signed actions to test the verifier against |
| Land verifier + verify-trail CLI | Low |

No data is rewritten. Old `activity_log` rows stay unsigned. Future flag flips trigger signing for new rows only.

## Risks + open questions

1. **Key custody.** v2a holds private keys in-process (libsodium, encrypted at rest via existing secret pattern). v2b should move enterprise customers to KMS. Document the migration path in v2b.
2. **Performance.** Ed25519 signing is fast (~0.1ms per op) but every `logActivity` call gains a sig step. Measure on the heartbeat hot path. Worst case: queue signing into a worker, accept eventual signing (signature lands later but before the next anchor batch).
3. **Downstream consumers.** `activity_log` gains four columns. Plugin event bus, live events WS, exports, and the company-portability bundle all need updates. Audit each surface during implementation - non-trivial work.
4. **WebCrypto compatibility.** Browser-side signing in v2b should be Ed25519 - check WebCrypto support across target browsers; fallback to a libsodium WASM bundle if needed.
5. **Schema versioning.** `envelope_v` lets us evolve the envelope without breaking historical verification. v2a only emits `v: 1`. Resist the temptation to bump it mid-phase.
6. **Pre-v2a row signing.** Genuinely cannot be done correctly - we don't have a key that "was" the agent's key at the time those actions happened. Verifier must distinguish "unsigned, pre-v2a" from "signed, broken." Document this in the verify-trail CLI output.

## Estimated effort

| Workstream | Engineer-days |
|---|---|
| Schema + migrations + `KeyStore` interface + libsodium impl | 2 |
| Sign-on-write in `logActivity` + new columns on `activity_log` | 2 |
| `delegations` table + issuance API endpoints | 3 |
| CoS sub-delegation validation logic | 2 |
| Verifier function + CLI | 2 |
| Tests (unit + integration) | 3 |
| Plugin event bus + live events WS migration | 2 |
| Total | **~16 engineer-days, or ~3-3.5 weeks for one engineer** |

## Relationship to standards (recap)

- **AIP draft** ([Singla](https://datatracker.ietf.org/doc/draft-singla-agent-identity-protocol/00/)) — our `delegations` table is the cap-chain. Cert payload format aligns with the draft's `Capability` structure.
- **ANS draft** ([Narajala](https://datatracker.ietf.org/doc/html/draft-narajala-ans-00)) — handled in v2c. v2a's public-key endpoint and per-agent key are prerequisites.
- **WIMSE / SPIFFE** ([draft-ni-wimse-ai-agent-identity](https://datatracker.ietf.org/doc/draft-ni-wimse-ai-agent-identity/)) — orthogonal. Adapter ships when an enterprise SPIFFE customer asks for it.
- **A2A AgentCard** ([a2aproject/A2A](https://github.com/a2aproject/A2A)) — v2a delivers the building blocks (handle + key + signature). Card endpoint is v2c.
- **W3C DID Core** — v2a's per-agent key is already DID-shaped material. `did:web:<handle>` resolver is a one-day add in v2c.

## References

- v1 design: [docs/superpowers/specs/2026-05-13-delegation-and-attestation-design.md](2026-05-13-delegation-and-attestation-design.md)
- v1 PR: [agentdash#289](https://github.com/thetangstr/agentdash/pull/289)
- W3C DID Core: https://www.w3.org/TR/did-core/
- AIP IETF draft: https://datatracker.ietf.org/doc/draft-singla-agent-identity-protocol/00/
- ANS IETF draft: https://datatracker.ietf.org/doc/html/draft-narajala-ans-00
- WIMSE AI agent draft: https://datatracker.ietf.org/doc/draft-ni-wimse-ai-agent-identity/
- A2A project: https://github.com/a2aproject/A2A
- Linux Foundation A2A 1-year update (150+ orgs): https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
