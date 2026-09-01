# Scope: over-the-air updates for an on-prem AgentDash

Date: 2026-08-18
Status: scoped, not started
Prerequisite: PR #477 merged (`2d99f5389`)

## What exists today, on the real machine

Written from the live MKThink Mac Mini (`mkmini.local`), not from memory:

- The application runs **from a git checkout**: `/Users/yang/agentdash`, executed
  through `tsx` by `deploy/agentdash-server.sh`. Updating means `git pull` by
  hand, over SSH, by someone with the repo.
- Supervision is `launchd`. The production instance is owned by the system
  daemon `/Library/LaunchDaemons/com.agentdash.mkboard.server.plist`
  (`KeepAlive: true`, runs as `yang`).
- Caddy terminates TLS on `:3112` and proxies to `127.0.0.1:3102`.
- Postgres runs under `com.agentdash.postgres`; automatic dumps land in
  `~/.paperclip/instances/mkboard/data/backups` with a 7d/4w/1m retention.
- `com.agentdash.renew-tls` is an existing, working precedent for a small
  privileged LaunchDaemon doing one scheduled job.
- There is plugin/skill upgrade machinery. There is **no** core application
  updater of any kind.

## Why this is worth building

Every fix reaches this customer only by a person with a terminal SSHing in. That
is the current cost of the invite fix, the TLS daemon, and the codex-local
adapter fix. It does not scale past one design partner, and it means the client's
box silently drifts from `main`.

## A caution the restart taught us today

While rolling out this very change, a `launchctl kickstart` produced **two**
mkboard servers: the LaunchAgent and the system LaunchDaemon both supervised the
same instance, and the loser of the port race silently fell back from 3102 to
3103 — healthy-looking, reachable, and serving nobody, because Caddy only proxies
3102. Killing the wrapper did not kill the server either: `exec pnpm exec tsx`
leaves a grandchild node process that survives and reparents to `init`, holding
the port.

The lesson for this feature: **an updater that cannot deterministically stop the
old process will produce two servers and call it success.** Restart semantics are
not a detail to add at the end; they are the risky part. Any design here must
kill by port ownership and verify the port is free, not merely signal a job.

## Design

1. **Signed release manifest**, published per channel (`stable`, `canary`):
   version, artifact URL, SHA-256, minimum compatible schema version, release
   notes. Signature verified against a public key baked into the install, not
   fetched.
2. **Server-side version check** on a timer. Compares the running commit/version
   to the channel manifest. No download, no side effects.
3. **Admin-only UI banner** — "AgentDash 2026.x is available" — visible to
   instance admins only, with the release notes inline.
4. **Explicit admin confirmation.** Never auto-install on an on-prem box. The
   person who owns the machine decides when it restarts.
5. **A narrowly scoped privileged helper**, modelled on `com.agentdash.renew-tls`:
   download → verify signature and checksum → back up database and config →
   stage the release in a new directory → stop the old process (by port
   ownership, verified free) → start the new one → run migrations → health-check.
   The web server never gets general root.
6. **Atomic release directories with a symlink switch**, so a failed health check
   flips the symlink back and restarts the previous release. The rollback path
   must be exercised, not merely written.
7. **Preserve across releases**: `~/.config/agentdash/*.env`, instance data under
   `~/.paperclip/instances/`, databases, and user-created skills. Anything the
   customer authored survives; only the application is replaced.
8. **Audit every check, install, and rollback** as a first-class record — who
   confirmed, which version, which outcome.

## Test matrix (the failures, not the happy path)

Interrupted download; invalid signature; checksum mismatch; migration failure
mid-run; new release fails its health check; old process refuses to die and holds
the port; disk full while staging; and a release that changes the updater itself.
The last one is the one that strands a customer, and it is the one most likely to
be skipped.

## Sequencing

Ship in this order, each independently useful:

1. Version check + admin banner. Read-only, near-zero risk, immediately tells
   Titus their box is behind.
2. Manifest signing and verification.
3. The privileged helper, install, and rollback.

## Open question

Does the Mini update from a git checkout it keeps, or from a built artifact?
Today it runs TypeScript through `tsx` out of a working tree, which makes `git
pull` tempting as the whole updater. It is also what lets a half-pulled tree run.
A built, versioned artifact is the more honest answer and makes the rollback
symlink meaningful — but it is a bigger change to how this machine has always
been deployed, so it is a decision to make deliberately rather than by default.
