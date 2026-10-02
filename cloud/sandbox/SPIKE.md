# Spike: per-company cloud sandbox for the travel picker (Phase 1)

Date: 2026-10-02. Lane: `devin/sandbox-20261002`. Status: design + local
prototype. **No cloud resources were created; nothing was spent; no running
instance was touched.**

This spike proves the sandbox shape on a Mac with Docker and writes down the
exact Phase-1 (one EC2 per company) plan for the founder to execute.

## What exists here

| Piece | File | Notes |
|---|---|---|
| Image definition | `Dockerfile` | node24-bookworm-slim + nftables; users `agent`/`signer`/`svc`; groups `signsock`, `runshare` |
| Egress spec (typed) | `egress.spec.json` + `cloud/src/sandbox/egress-spec.ts` | zod schema; per-identity allow-lists; `optional` hosts render as comments |
| Egress renderer | `render-egress.mjs` | single implementation, used in-image AND by the TS wrapper |
| Egress apply | `egress-apply.sh` | DNS+uid resolution, `nft -f`, idempotent (deletes the table first; bookworm nft 1.0.6 has no `destroy`) |
| Signer daemon | `signerd.mjs` | unix socket, newline-JSON; session keys + company file key; policy-enforced |
| Guest lifecycle agent | `sandbox-ctl.mjs` | the R4 ops in-guest; ordering enforced here too |
| Forwarder stub | `forwarder.mjs` | proves the svc identity + sealed-token file contract |
| Lifecycle API | `cloud/src/sandbox/lifecycle/` | zod schemas, idempotency map, audit records |
| Drivers | `local-vm-driver.ts`, `ec2-driver.ts` | fake VM runs the real ctl; EC2 driver maps to SSM/EC2 calls via injected clients |
| Evidence | `cloud/src/sandbox/evidence.ts` | R8 record schema + generator |
| Health | `sandbox-ctl.mjs health` / `healthcheck.sh` | R9 check list |
| Timings | `measure.sh` | the numbers below |

## Architecture recap (as built)

```
EC2 instance (one per company)                <- real kernel, per-company
├── uid agent (1101)   Hermes / glm-5.3-flash  egress: model + mcp.clockchain.network
├── uid signer (1102)  signerd on unix sock    egress: none today; KMS endpoint in Phase 1
├── uid svc   (1103)   adapter + forwarder     egress: telemetry sink + Sepolia RPC
│      sign.sock  signer:signsock 0660        (agent can ASK, never read)
│      /etc/sandbox-signer/ signer:signer 0700 (key material lives here / KMS)
└── root               sandbox-ctl via SSM SendCommand (replaces sudo-over-SSH)
```

Three OS identities, not two: the brief's "services" identity (R3) is `svc` —
the Clockchain local adapter and telemetry forwarder run there, so a
compromise of either cannot read the signer key even though they share the
socket group.

## Measured local timings

Host: Mac Studio (M-series), Docker Desktop 29.3.1, machine under heavy
multi-agent load during measurement — treat as upper bounds for the *guest*
numbers (they're in-container and barely host-sensitive) and noisy for
docker-level numbers.

| Stage | Measured | Note |
|---|---|---|
| Image build (cold) | ~33.6 s | one-time per image release; irrelevant to run latency |
| Container start → signer socket answering | ~4.3 s | includes egress apply + signerd boot |
| egress apply (re-render + nft -f) | ~4.0 s | DNS-bound: dominated by `getent` lookups |
| signer init roundtrip | ~1.9 s | unix socket JSON-RPC, key loaded/verified |
| apply-run-config roundtrip | ~0.8 s | mints session + adapter + forwarder keys |
| `healthcheck.sh` (9 checks) | ~0.8 s | inside the container |

Resulting image ID (this checkout):
`sha256:0a9ef8a685ea983706f36c202ca624c457462a6b64ebe49742e30c70a45e7b41`
— the kind of digest that lands in the R8 `imageDigest` field once an AMI
pipeline exists (an AMI's evidence pin is the AMI id + source image digest).

Verified end-to-end in the running container: agent uid gets `Permission
denied` on the signer key, `wire_transfer` signing is refused with
`policy_denied`, an off-allow-list connect from the agent uid fails fast
(reject, not timeout) while `api.z.ai:443` connects, `nft list table inet
sandbox_egress` shows per-uid rules under `policy drop`, and
`healthcheck.sh` passes all 9 checks. Repro: `pnpm vitest run
src/__tests__/sandbox-container.test.ts` from `cloud/` (requires Docker;
skips cleanly without it).

## Projected EC2 numbers (Phase 1), with assumptions

Assumptions: `t4g.large`, AMI pre-baked with the image contents (no runtime
pull), instance already exists in the warm pool (stopped, EBS attached), same
AZ, SSM agent baked and registered.

| Step | Projected | Basis |
|---|---|---|
| Warm claim: StartInstances → running | ~20–35 s | published start times for stopped EBS-backed instances; adds SSM re-registration ~10 s |
| Guest ready: egress apply + signerd + health | ~3–6 s | mirrors the container path above (container ≈ VM guest cost; no VM boot) |
| Per-run lifecycle: open → config → token | < 1 s | in-guest ctl ops are file+socket work |
| **Total warm-pool path to handshake-open** | **~30–45 s** | inside the 90 s budget (R5) |
| Cold path: RunInstances → ready | ~60–120 s | AMI boot ~25–45 s + SSM register; exceeds 90 s only on pool miss — pool depth is the fix, not speed |
| Fresh image build (AMI bake) | ~3–6 min | one-time per image change, off the run path |

Conclusion: warm pool of stopped instances is the correct mechanism (R5);
the picker binds handshakes in its 10-minute window, and ~45 s is 8× margin.

## Phase-1 AWS resources + IAM (exact list)

The call plan is also exported as data — `EC2_PHASE1_PLAN` in
`cloud/src/sandbox/lifecycle/ec2-driver.ts`.

**Per-company resources**

- 1× EC2 `t4g.large` (`i-…`), AMI = sandbox image baked by EC2 Image Builder
  (or Packer) from this Dockerfile layout; root = gp3 20 GiB encrypted,
  `DeleteOnTermination`; tags: `agentdash:sandbox=<companyId>`,
  `agentdash:image-digest=<sha256:…>`
- Security group: inbound NONE (SSM is outbound); outbound `tcp/443`,
  `tcp/53`, `udp/53` only — the fine-grained per-uid rules live in nftables
  in-guest; the SG is a coarse backstop
- Instance profile `sandbox-instance-role` on `AmazonSSMManagedInstanceCore`
  + `kms:Sign`, `kms:GetPublicKey` on that company's key ARN
- 1× KMS asymmetric signing key per company (`ECC_SECG_P256K1` or
  `ECC_NIST_P256` — see open questions), key policy scoped to the instance
  role
- No inbound connectivity, no SSH key pair, IMDSv2 required hop-limit 1

**Shared/control-plane**

- Warm pool: N stopped instances per company (or per region, tagged
  `pool:unclaimed` and claimed by tag) — StopInstances is nearly free
- IAM `sandbox-control-role` (assumed by the control plane):
  `ec2:RunInstances|StartInstances|StopInstances|TerminateInstances|DescribeInstances|CreateTags`
  conditioned on `aws:RequestTag/ResourceTag agentdash:sandbox`,
  `ssm:SendCommand|GetCommandInvocation` on `arn:aws:ec2:*:*:instance/*`
  with `ssm:resourceTag/agentdash:sandbox` + document `AWS-RunShellScript`,
  `iam:PassRole` limited to `sandbox-instance-role`
- CloudTrail (already-on for the account) covers control-plane-side auditing;
  the in-guest audit records are the lifecycle service's job
- AMI baking: EC2 Image Builder pipeline (or `packer build`) — produces the
  digest that lands in run evidence

## Cost per sandbox-hour (us-east-1, on-demand, Oct 2026 prices)

| Item | Running | Parked (warm pool) |
|---|---|---|
| t4g.large compute | $0.0672/h | $0 (stopped) |
| gp3 20 GiB | ~$0.0022/h equivalent | same (~$1.60/mo) |
| KMS key | $1/mo flat (~$0.0014/h) | same |
| KMS sign ops | $0.03/10k — negligible at handshake volume | — |
| SSM | $0 for these calls | — |
| Egress GB | $0.09/GB — demo traffic is MBs | — |
| **≈ total** | **~$0.071/h** | **~$0.004/h** |

Two demo companies ≈ **$3.40/day** fully warm, or under **$0.20/day** parked
except during demos. Spot is inappropriate here (interruption mid-handshake).

## Open questions for the Clockchain side

1. **Signing curve.** KMS has no ed25519. The prototype uses ed25519 file
   keys; Phase 1 KMS forces `ECC_SECG_P256K1` (good if Clockchain wants
   Ethereum-style secp256k1 addresses) or `ECC_NIST_P256`. Clockchain's ERC-8004
   flow suggests secp256k1; confirm which curve + digest (keccak256 vs sha256;
   KMS `MessageType=DIGEST` wants the caller's digest).
2. **Exact egress hosts.** `api.z.ai` (GLM) and `mcp.clockchain.network` are
   assumed; the Sepolia RPC (Alchemy/Infura keyed? `publicnode`?) and the
   telemetry sink hostname need real values. KMS endpoint is per-region.
3. **Mint-service timeline.** Ingest tokens are minted per run and sealed to
   the forwarder key — needs the sink operator's mint endpoint + the sealing
   scheme (X25519-HPKE assumed; forwarder pub is `forwarderSealingPublicKeyB64`).
4. **Verifier evidence schema.** `runEvidenceSchema` is our proposal; the
   verifier needs to agree on fields, and on how it gets the disclosed guest
   event log the `eventLogSha256` pins.
5. **Egress pinning vs DNS churn.** nftables pins IPs resolved at apply
   time. If `mcp.clockchain.network` rotates IPs mid-run, the rule is stale —
   options: short TTL re-apply, per-identity forward proxy, or CIDR allows.

## What is deliberately not here

- No HTTP surface for the lifecycle service (it's a service boundary now;
  the picker service wraps it in routes later)
- No real telemetry forwarder network path (stub proves the file/identity
  contract)
- No AMI baking pipeline (the Dockerfile is the build contract; Image Builder
  recipe is founder work)
- `clear` cannot be made unclean: in the VM, `/run/sandbox` is tmpfs, so a
  stopped instance forgets everything anyway — the ctl wipe is belt and
  suspenders for warm-pool reuse
