---
title: Deploy overview
summary: AgentDash Cloud is the hosted option; this section covers running AgentDash yourself
---

Most people should use **AgentDash Cloud**, the hosted product. You sign up, claim a workspace and start. See [Start on AgentDash Cloud](/start/quickstart).

This section is for running AgentDash on your own machine or server (self-hosting).

## Self-host options

| Option | Use it when | Page |
|---|---|---|
| Docker | You want one container (or a container plus PostgreSQL) on any Docker host | [Docker](/deploy/docker) |
| Mac mini with launchd | You want an always-on Mac on a private network, run from a pinned source checkout | [macOS (launchd)](/deploy/macos) |
| From a source clone | You are developing AgentDash itself | [Local development](/deploy/local-development) |

To reach a self-hosted instance from other devices without exposing it to the internet, see [Tailscale private access](/deploy/tailscale-private-access).

## Pick a deployment mode

Every instance runs in one of three configurations. The mode decides whether people sign in; the bind setting decides which network interfaces the server listens on.

| Mode | Sign-in | Use it for |
|---|---|---|
| `local_trusted` | None | One person on one machine (the default) |
| `authenticated` + `private` | Required | A team on a private network (Tailscale, VPN, LAN) |
| `authenticated` + `public` | Required | An internet-facing server behind a reverse proxy |

Details and the rules the server enforces at startup: [Deployment modes](/deploy/deployment-modes).

## Reference

- [Database](/deploy/database): embedded PostgreSQL or your own
- [Storage](/deploy/storage): local disk or S3-compatible object storage
- [Secrets](/deploy/secrets): the local master key and strict mode
- [Environment variables](/deploy/environment-variables): every server setting you can pass in the environment
