# TLS front door, and reaching this box from off the LAN

`Caddyfile` here is the copy of what runs at
`~/.config/agentdash/Caddyfile`. Keep them in step — the LaunchDaemon reads the
one in `~/.config`, so this copy exists so the config survives a rebuild, not
so it can be edited in place.

## The thing that was nearly missed

The first version of this config served only `mkmini.local`. That name is mDNS:
it resolves for a machine on the same physical LAN and **nowhere else** — in
particular it does not resolve over Tailscale, because mDNS is link-local and a
tailnet is a routed overlay.

Plain HTTP hid the problem, because the servers bind `*` and answer on every
address. Measured before the fix:

| URL | result |
|---|---|
| `http://100.64.89.16:3102/api/health` | **200** |
| `https://100.64.89.16:3112/api/health` | **000** — connection dropped |
| `https://yangs-mac-mini.tail112187.ts.net:3112/api/health` | **000** |

So anyone connecting over Tailscale would have landed on the **plaintext** port,
found it working, and had no reason to think that was not the intended path. The
TLS work would have looked done and been bypassed in practice.

Two causes, both fixed here:

1. **No site block matched.** Caddy closes the connection when nothing matches
   the SNI, and a request to a bare IP sends no SNI at all — hence a block for
   the IPs specifically, not just the names.
2. **The certificate did not cover those names.** The original mkcert cert
   carried `mkmini.local, *.mkmini.local, localhost, 127.0.0.1`. It was reissued
   as `mkmini-multi.pem` adding `yangs-mac-mini.tail112187.ts.net`,
   `100.64.89.16` and `192.168.86.57`.

After the fix, all four addresses return 200 on both instances, verified with
`--cacert` against the real mkcert root rather than `-k`.

## Writes, and a 403 that meant nothing

A first probe POSTed to `127.0.0.1:3102` while sending a Tailscale `Origin`
header, got a 403, and looked like proof that writes were broken over Tailscale.
It was not. `board-mutation-guard.ts` trusts
`http(s)://<Host or X-Forwarded-Host>`, so the only thing that matters is
whether Caddy forwards the original Host — which cannot be observed by a request
that never goes through Caddy. That combination of headers is one no browser
produces.

Retested **through** Caddy, with the CA trusted:

```
https://yangs-mac-mini.tail112187.ts.net:3112  GET=200 POST=201
https://100.64.89.16:3112                      GET=200 POST=201
https://mkmini.local:3112                      GET=200 POST=201
```

Reads and writes both work. The rule that caught this is the same one as
everywhere else in this repo: a 403 is inconclusive until the request that
produced it is one a real client would have made.

## Better, when someone can reach the Tailscale admin console

`tailscale cert yangs-mac-mini.tail112187.ts.net` would issue a **publicly
trusted** certificate for the `.ts.net` name, and nobody would need the mkcert
root installed at all. It fails today:

```
500 Internal Server Error: acme: order ... status: invalid
```

which means HTTPS certificates are not enabled for this tailnet. That is a
toggle in the admin console (**DNS → HTTPS Certificates**) for the tailnet
owner, and it cannot be set from this machine. Until then the mkcert CA still
has to be installed on each person's machine.

## Reloading

`caddy reload --config ~/.config/agentdash/Caddyfile` — no sudo needed, because
the process runs as `yang`. `launchctl kickstart -k system/com.agentdash.caddy`
also works but needs a password.
