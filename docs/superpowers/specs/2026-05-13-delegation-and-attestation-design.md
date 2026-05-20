# Delegation + Attestation Design

**Status:** Draft (v1 scope locked, v2/v3 deferred)
**Last updated:** 2026-05-13
**Author:** AgentDash team

## Why

Enterprise customers buying AgentDash want two things our current architecture cannot prove:

1. *Who authorized this agent to do that?* — a cryptographic delegation chain from a corporate identity to a specific agent action.
2. *Did this audit log get tampered with?* — a third-party-verifiable, tamper-evident audit trail.

These map directly to the Argus model: cryptographic **delegation certificates** that bind an agent to `{scope, purpose, duration}`, plus an immutable **Trail** of events with hash-chained chain-of-custody.

This spec defines the *minimum* shape we ship now (v1 = audit trail anchoring) and the path to full Argus parity later (v2 = delegation enforcement, v3 = ratification UI + A2A).

## Non-goals (v1)

- Delegation certificates with scope/purpose/expiry enforcement — deferred to **v2**.
- Per-agent Ed25519 keypairs — deferred to **v2**.
- Alignment Trace UI / human ratification ceremony — deferred to **v3**.
- Cross-org A2A capability tokens — deferred to **v3**.
- Replacing `activity_log` semantics — v1 only *adds* anchoring on top.

## v1 — Audit trail anchoring (this PR)

### Outcome

Anyone with read access to our DB and an internet connection can prove that a window of `activity_log` rows existed at a specific time and has not been altered since, **without trusting AgentDash**.

### Architecture

```
                          ┌───────────────────┐
                          │ activity_log      │  (existing, unchanged)
                          └────────┬──────────┘
                                   │ read recent rows
                                   ▼
                          ┌───────────────────┐
                          │ attestation       │  (new service)
                          │ service           │
                          └────────┬──────────┘
                                   │ canonicalize → SHA-256
                                   ▼
                          ┌───────────────────┐
                          │ AnchorAdapter     │  (interface)
                          │  ├ NoopAdapter    │  (default; dev/CI)
                          │  ├ ClockchainAdpt │  (POST /log)
                          │  └ <future: OTS>  │
                          └────────┬──────────┘
                                   │
                                   ▼
                          ┌───────────────────┐
                          │ trail_anchors     │  (new table)
                          │  (prev_anchor_id, │
                          │   payload_hash,   │
                          │   external_log_id)│
                          └───────────────────┘
```

### Data model

New table `trail_anchors`:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `company_id` | `uuid` FK | Per-company chain |
| `prev_anchor_id` | `uuid` FK self | Chain-of-custody pointer (null for genesis) |
| `prev_payload_hash` | `text` | Frozen copy of parent hash (defense in depth) |
| `batch_start_activity_id` | `uuid` | Inclusive lower bound |
| `batch_end_activity_id` | `uuid` | Inclusive upper bound |
| `batch_activity_count` | `integer` | Sanity check |
| `manifest_sha256` | `text` (hex) | SHA-256 of canonical batch JSON |
| `manifest_preview` | `jsonb` | First N entries + count (for fast UI lookups; not the trust root) |
| `adapter` | `text` | `"noop"`, `"clockchain"`, etc. |
| `external_log_id` | `text` nullable | What the adapter returned |
| `external_block_height` | `bigint` nullable | If adapter is chain-anchored |
| `external_anchored_at` | `timestamptz` nullable | Adapter's reported time |
| `status` | `text` | `"pending"`, `"anchored"`, `"failed"` |
| `last_error` | `text` nullable | If failed |
| `created_at` | `timestamptz` | |
| `anchored_at` | `timestamptz` nullable | When status flipped to anchored |

### Hash construction (canonical)

For a batch `[a₁, a₂, …, aₙ]` of activity rows, the **manifest** is:

```json
{
  "v": 1,
  "companyId": "<uuid>",
  "prevPayloadHash": "<hex or null>",
  "count": <n>,
  "entries": [
    {"id":"<uuid>","createdAt":"<iso>","action":"<str>","entityType":"<str>","entityId":"<uuid>","actorType":"<str>","actorId":"<str>","detailsHash":"<hex>"},
    ...
  ]
}
```

`detailsHash` is `SHA-256(JSON.stringify(details))` — including a hash of details lets us prove integrity *without* shipping potentially sensitive PII to an external chain. The manifest itself contains only IDs + actions + the hash.

The `payload_hash` on the anchor row is `SHA-256(canonicalJSON(manifest))`. **That hash** is what we send to Clockchain (or any anchor).

### AnchorAdapter interface

```typescript
export interface AnchorAdapter {
  readonly name: string;
  getVerifiedTime(): Promise<VerifiedTime>;
  anchorBatch(
    payloadHash: string,
    metadata: AnchorMetadata,
  ): Promise<AnchorResult>;
  verifyAnchor(
    externalLogId: string,
    expectedPayloadHash: string,
  ): Promise<VerificationResult>;
}
```

- `NoopAdapter` — returns a synthetic `external_log_id`, used in dev/CI when no key.
- `ClockchainAdapter` — wraps `POST /log` + `GET /searchAsset`.

### Loop

A `setInterval` tick (default every 5 min, configurable via `AGENTDASH_ATTESTATION_INTERVAL_MS`) does:

1. For each company with un-anchored activity since the last anchor:
   1. Pull rows `(prev_end_activity, latest_activity]` capped at N (default 500).
   2. Build manifest → compute `payload_hash`.
   3. Insert `trail_anchors` row, `status='pending'`.
   4. Call `adapter.anchorBatch(payload_hash, …)`.
   5. On success: update row to `status='anchored'`, fill external fields.
   6. On failure: update `status='failed'`, store error, retry next tick.

### Feature flag + env

| Variable | Default | Purpose |
|---|---|---|
| `AGENTDASH_ATTESTATION_ENABLED` | `false` | Master switch. |
| `AGENTDASH_ATTESTATION_ADAPTER` | `noop` | `noop` \| `clockchain`. |
| `AGENTDASH_ATTESTATION_INTERVAL_MS` | `300000` (5 min) | Tick cadence. |
| `AGENTDASH_ATTESTATION_BATCH_LIMIT` | `500` | Max activity rows per batch. |
| `CLOCKCHAIN_API_KEY` | — | Required when adapter is `clockchain`. |
| `CLOCKCHAIN_API_BASE` | `https://node.clockchain.network/` | |

### Verification

A read-only helper (`packages/attestation/src/verify.ts`, callable from CLI later) takes a `trail_anchor` row, re-fetches the activity rows, re-builds the manifest, re-hashes, and asks the adapter to confirm the external anchor. Returns `{ ok, mismatches, externalProof }`.

### Risk controls

- **Schema-only by default.** Migration adds a table; nothing reads from it unless the env flag is on.
- **Adapter defaults to `noop`** so a half-configured prod can't accidentally call out.
- **All adapter HTTP calls have a 10s timeout** + bounded retry within a tick.
- **Per-company isolation** — one company's bad batch can't poison another.
- **Activity log is unchanged.** v1 is purely additive.

---

## v2 — Delegation enforcement (deferred)

When customer demand makes this load-bearing:

1. **`delegations` table**: `{principal_user_id, agent_id, scopes[], purpose, not_before, not_after, parent_delegation_id, signer_pubkey_id, signature}`.
2. **`agent_keys` table**: Ed25519 keypair per agent, private key in KMS / libsodium.
3. **Signed activity envelope**: each `activity_log.details` gains `{delegation_id, signature, pubkey_id}`; the manifest above will include these signatures.
4. **Boundary enforcement** in `server/src/services/heartbeat.ts`: actions cite a `delegation_id`; out-of-scope or expired → 403.
5. **CoS sub-delegation**: agents with `role='chief_of_staff'` can mint child delegations to worker agents (inherited + narrowed scope).

## v3 — Alignment Trace UI + A2A (deferred)

1. Node-graph UI rendering parallel agent conversations for human ratification.
2. Linux Foundation A2A v1.0 capability tokens for cross-workspace / cross-org agent negotiation.
3. WorkOS / Okta-bound human signing for `CoS.md`-style top-level delegation certs.

---

## What we're explicitly *not* doing

- **No on-chain payloads.** Only hashes leave our infra. No PII anywhere external.
- **No multi-tenant API keys for Clockchain.** Single service-account key per environment.
- **No vendor lock-in.** `AnchorAdapter` is the seam; OpenTimestamps / Sigstore are plausible second adapters.

## References

- Argus product docs — https://docs-fawn-theta.vercel.app/argus-product.html
- Clockchain technical guide (logging) — `/logging-technical-guide` on services.clockchain.network
- Clockchain technical guide (timestamp) — `/timestamp-api-technical-guide`
- A2A v1.0 — Linux Foundation Agent-to-Agent protocol
- OpenTimestamps — opentimestamps.org
