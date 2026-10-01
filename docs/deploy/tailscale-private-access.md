---
title: Tailscale private access
summary: Reach a self-hosted AgentDash from other devices on your tailnet or LAN, with sign-in required
---

Use this when you want other devices to open your AgentDash instance over Tailscale (or a private LAN or VPN) without exposing it to the internet. The instance runs in `authenticated` + `private` mode, so everyone signs in.

## 1. Start the server on a private bind

From a source clone:

```sh
pnpm dev --bind tailnet   # listen on this machine's Tailscale address only
pnpm dev --bind lan       # listen on all interfaces (LAN, VPN and tailnet)
```

Either preset sets these for the server (source: `scripts/dev-runner.ts`):

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_BIND=tailnet   # or lan
```

For an installed instance (Docker, launchd), set the same variables in its environment. Authenticated mode also needs `BETTER_AUTH_SECRET`.

`tailnet` finds the address by running `tailscale ip -4`. Set `PAPERCLIP_TAILNET_BIND_HOST` to choose the address yourself. If Tailscale is not running when the server starts, it falls back to loopback and logs a warning. Source: `server/src/config.ts`.

With `tailnet`, the server listens only on the Tailscale address, so `localhost` on the same machine does not reach it.

## 2. Find the address

On the machine running AgentDash:

```sh
tailscale ip -4
```

You can also use the machine's MagicDNS name, for example `my-laptop.example-tailnet.ts.net`.

## 3. Allow the hostname

In `private` exposure, the server rejects requests whose `Host` is not on its allowlist, with a 403 that names the hostname. The allowlist always holds `localhost`, `127.0.0.1`, `::1`, the address the server is bound to and the host of `PAPERCLIP_PUBLIC_URL` if set. Add anything else you will type in a browser, such as a MagicDNS name or a LAN IP:

```sh
pnpm paperclipai allowed-hostname my-laptop.example-tailnet.ts.net
```

That writes to the instance config. Or set `PAPERCLIP_ALLOWED_HOSTNAMES` (comma-separated) in the environment. Source: `server/src/middleware/private-hostname-guard.ts`.

If people reach the instance on more than one address, declare them with `PAPERCLIP_CANONICAL_ORIGIN` and `PAPERCLIP_ORIGINS`; see [Environment variables](/deploy/environment-variables).

## 4. Open it from another device

```txt
http://<tailscale-address-or-name>:3100
```

## 5. Check it

From another device on the tailnet:

```sh
curl http://<tailscale-address-or-name>:3100/api/health
```

The response is JSON with `"status": "ok"`.

## Troubleshooting

- **403 "Hostname ... is not allowed"**: add that hostname with `pnpm paperclipai allowed-hostname <host>`, then restart.
- **Works on `localhost` only**: the server is on the default loopback bind. Start it with `--bind lan` or `--bind tailnet`, or set `PAPERCLIP_BIND`.
- **Works locally but not from another device**: check both devices are on the same tailnet and that port `3100` (or your `PORT`) is reachable.
