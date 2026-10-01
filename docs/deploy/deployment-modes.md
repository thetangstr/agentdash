---
title: Deployment modes
summary: local_trusted or authenticated, private or public exposure, and the bind setting
---

Two settings decide who can use an instance and how:

- **Mode**: `local_trusted` (no sign-in) or `authenticated` (sign-in required). `authenticated` has an **exposure**: `private` or `public`.
- **Bind**: which network interfaces the server listens on. `loopback`, `lan`, `tailnet` or `custom`.

Source: `packages/shared/src/constants.ts` (`DEPLOYMENT_MODES`, `DEPLOYMENT_EXPOSURES`, `BIND_MODES`), `server/src/config.ts`.

## Modes

| Mode | Exposure | Sign-in | Use it for |
|---|---|---|---|
| `local_trusted` | `private` only | None | One person on one machine. The default. |
| `authenticated` | `private` | Required | A team on a private network (Tailscale, VPN, LAN) |
| `authenticated` | `public` | Required | An internet-facing server, usually behind a reverse proxy |

### `local_trusted`

- No sign-in. The server creates a local board user and makes it the instance admin.
- Must bind to loopback. The server refuses to start otherwise.
- Company deletion is allowed by default (`PAPERCLIP_ENABLE_COMPANY_DELETION` overrides it in either mode).

### `authenticated` + `private`

- Sign-in through Better Auth. `BETTER_AUTH_SECRET` must be set.
- The auth base URL is derived from the request (`auto`) unless you set a public URL.
- A hostname allowlist applies: requests for a host that is not allowed get a 403. See [Tailscale private access](/deploy/tailscale-private-access).
- Any bind works.

### `authenticated` + `public`

- Sign-in required.
- The server refuses to start without an explicit public URL (`PAPERCLIP_PUBLIC_URL`, `PAPERCLIP_AUTH_PUBLIC_BASE_URL` or `PAPERCLIP_CANONICAL_ORIGIN`), which puts the auth base URL in `explicit` mode.
- `tailnet` bind is not allowed. Bind to `loopback` behind a reverse proxy; `lan` or `custom` also work.

The startup checks are in `server/src/index.ts` and `packages/shared/src/network-bind.ts`.

## Bind

| Bind | Listens on | Typical use |
|---|---|---|
| `loopback` | `127.0.0.1` | Local use, or behind a reverse proxy |
| `lan` | all interfaces (`0.0.0.0`) | LAN, VPN or tailnet access |
| `tailnet` | the Tailscale address from `tailscale ip -4` (or `PAPERCLIP_TAILNET_BIND_HOST`) | Tailscale-only access |
| `custom` | the host in `PAPERCLIP_BIND_HOST` | A specific interface |

If `PAPERCLIP_BIND` is not set, the server infers the bind from `HOST`.

## Setting the mode

With the repository CLI (from a clone; see [Local development](/deploy/local-development)):

```sh
pnpm paperclipai onboard                       # interactive; asks reachability first
pnpm paperclipai onboard --yes --bind lan      # quickstart with a preset
pnpm paperclipai configure --section server    # change it later
```

Or with environment variables, which override the config file:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated \
PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
PAPERCLIP_BIND=lan \
BETTER_AUTH_SECRET=... \
pnpm paperclipai run
```

## First admin

In `authenticated` mode, an instance with no instance admin reports `"bootstrapStatus": "bootstrap_pending"` on `/api/health`. Make the first admin one of two ways:

- **Bootstrap invite.** Run `pnpm paperclipai auth bootstrap-ceo`. It prints a one-time invite URL; the person who accepts it becomes the instance admin. The command finds the database through `DATABASE_URL` or the instance config. Source: `cli/src/commands/auth-bootstrap-ceo.ts`.
- **Self-serve bootstrap.** Set `AGENTDASH_SELF_SERVE_BOOTSTRAP=true`. The first signed-in user to create a company, while no instance admin and no other company exist, becomes the instance admin. Source: `server/src/services/access.ts`. Anyone who can reach the sign-up page can be that user, so use it only on a private network, and consider `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` once your team has accounts.

## Moving from `local_trusted` to `authenticated`

When an `authenticated` instance's only instance admin is the local board user left over from `local_trusted`, the server prints a one-time claim URL at startup:

```txt
/board-claim/<token>?code=<code>
```

Sign in as a real user and open it. That user becomes the instance admin, the local board user loses the role, and the user gets active membership in every existing company. Source: `server/src/board-claim.ts`.
