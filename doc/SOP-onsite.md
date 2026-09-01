# On-site SOP — putting the Mini on MKThink's network

**Audience:** you, standing in their server room, possibly without much time.
**Short version:** plug it in, run one script, read what it tells you.

---

## The one thing to remember

```
cd ~/agentdash && ./deploy/relocate.sh
```

That is the whole technical procedure. Everything below is context for when it
says something you did not expect, plus the parts a script cannot do — which are
all about **people**, not machines.

---

## Before you leave

Run it from `~/agentdash` — the checkout is there, not in
`~/Documents/projects/agentdash`, which holds nothing but a `.DS_Store`.

| # | do | status | why |
|---|---|---|---|
| 1 | `cd ~/agentdash && ./deploy/relocate.sh --check` | ✅ passes 2026-08-17 | Confirms the script runs clean on a network you know. Changes nothing. |
| 2 | Send MKThink IT the certificate request | ⬜ open | **Do not plan on a USB stick.** See "The certificate problem" — transfer was never the hard part, and IT has lead time. |
| 3 | Get Titus a password he sets himself | ✅ link issued 2026-08-17 | 7-day token, expires **24 Aug**. See "Getting Titus in". Nobody has his current password and it is written down nowhere — this is the way round it. |
| 4 | `sudo scutil --set ComputerName` | ✅ done 2026-08-17 | Now `mkthink agentdash`. Check with `scutil --get ComputerName`. |
| 5 | `sudo` set `KeepAlive` to `<true/>` in the four server/db plists | ⬜ recommended | Makes a graceful `kill -TERM` restart actually work. See "Restarting an instance". Skip it and `relocate.sh` uses `SIGKILL` instead, which works but stops hard. |

### Restarting an instance

`KeepAlive {SuccessfulExit: false}` restarts a job **only when it exits
non-zero**. The server handles SIGTERM gracefully and exits 0, so:

| | result |
|---|---|
| `kill -TERM` | Stays down. launchd reads exit 0 as "it meant to stop". |
| `kill -KILL` | Comes back in ~10s. Exit 137 is non-zero, so KeepAlive fires. |
| `sudo launchctl kickstart -k system/com.agentdash.<inst>.server` | Comes back, needs a password. The recovery path. |

Measured 2026-08-17: a `kill -TERM` left `uat` dead with `last exit code = 0`
until `kickstart` was run. `relocate.sh` used to use SIGTERM, which means the
on-site procedure would have taken **both** instances down and left them there.
It now uses SIGKILL and prints the `kickstart` command if either fails to
return.

### The certificate problem

Getting `rootCA.pem` onto a machine is easy. **Trusting it is the hard part, and
on an MDM-managed Mac a non-admin user cannot do it at all** — Apple removed
silent CLI trust, so `security add-trusted-cert` prompts for admin credentials
no matter how the file arrived. USB, AirDrop, `scp`, HTTP: identical at the step
that matters. Many MDM fleets also block USB mass storage outright.

So do not try to solve delivery. Either get a certificate their machines already
trust, or stop using TLS on that path.

| option | each person does | needs |
|---|---|---|
| **A. Their IT issues the cert from MKThink's own CA** | nothing | one IT request. **Best end state** — their managed Macs already trust their own CA, so nothing new is trusted anywhere. |
| **B. Their IT pushes our `rootCA.pem` via MDM profile** | nothing | one IT request. Works, but asks them to trust an external root. |
| **C. Tailscale + Let's Encrypt** | install Tailscale, sign in, use the `.ts.net` URL | possibly the same IT request — **installing the client is privileged too.** Good for *your* remote support; awkward for their fleet. |
| **D. Plain HTTP `:3102`** | nothing | nothing. No encryption: session cookies travel in clear on their LAN. Demo stopgap only. |

Clicking through the warning is the option that teaches four people to click
through certificate warnings. It is not on the list.

### What to ask MKThink IT for

Lead with **A**. It is less to approve than B, and most IT teams find "issue a
cert from our own PKI" a far easier yes than "trust this root we've never seen".

> We're running an on-premise server on your network — a Mac Mini, hostname
> `mkmini.local` — that serves an internal web app over HTTPS on port 3112.
> Right now its certificate is self-issued, so every browser shows a warning.
>
> **Preferred:** could you issue a TLS server certificate from your internal CA
> for `mkmini.local` (SANs: `mkmini.local`, and the machine's LAN IP)? We'll
> install it on the server. Nothing changes on any laptop, because your machines
> already trust your CA.
>
> **Alternative,** if you'd rather not issue one: push our root CA to the three
> laptops that need access (Titus, Sam, Megan) as a trusted-root configuration
> profile. It's a public certificate, no private key. Details:
>
> ```
> subject      O=mkcert development CA, CN=mkcert yang@mac.lan
> serial       AE96879C1D8D528940CC8F46AFDFE397
> valid        2026-08-17 → 2036-08-17
> SHA-256      93:70:95:3E:31:59:4F:6D:B8:5F:25:1A:71:D4:3C:B3:
>              37:60:5A:99:B3:AF:57:99:AA:FA:71:D4:1B:FE:B2:63
> ```
>
> To be straight about the tradeoff: a trusted root can sign for *any* hostname,
> not just ours, so if you'd rather scope or decline it, option one is the better
> path for both of us. This root signs one internal hostname and is not a
> TLS-inspection proxy.

Answer they will probably ask for: the private key lives only on the Mini, in
`~/.config/agentdash/tls/`, and never leaves it.

**Put the network ask in the same ticket.** It is the same team, and the guest
Wi-Fi is not a viable home for this machine (see "Do not run this on the guest
Wi-Fi" below):

> The machine also needs a network home. Ideally:
>
> - A **wired Ethernet port on an internal VLAN** — not the guest network, which
>   usually isolates clients from each other and would stop staff reaching it.
> - A **DHCP reservation or static address**. MACs:
>   `en0` wired `1c:f6:4c:69:c6:9d`, `en1` Wi-Fi `1c:f6:4c:68:d0:2d`.
> - Reachable from three laptops on TCP **3102, 3112**.
> - Either **mDNS/Bonjour permitted** on that VLAN, or — better — an internal
>   **DNS A record** pointing at the reserved address.
>
> A DNS name is worth asking for even if mDNS works, because it makes the
> certificate above straightforward and removes our dependence on Bonjour.

If they give you a real DNS name, say `agentdash.mkthink.com`, that name replaces
`mkmini.local` everywhere: `PAPERCLIP_ALLOWED_HOSTNAMES`, `PAPERCLIP_PUBLIC_URL`,
the certificate SANs, and the Caddy site blocks. `relocate.sh` handles the
hostname set and the cert; the public URL is a manual edit in both env files. Any
invite or reset link minted before the rename keeps pointing at the old name, so
re-mint them after.

If IT is slow, run on **D** for the first demo and say plainly that TLS is
pending — do not ship a warning and hope nobody reads it.

---

## On site

### 1. Physical

Prefer **Ethernet** over Wi-Fi. It is currently on Wi-Fi (`en1`); a server in a
rack should not depend on a wireless association it cannot re-establish
unattended. The script detects whichever interface holds the default route, so
it does not care which you choose — but a reboot on Wi-Fi may come up before the
network does, and Ethernet removes that whole class of problem. `en0` has no
cable attached as of 2026-08-17, so **bring one**.

#### Do not run this on the guest Wi-Fi

`MKThinkGuest` is saved as a preferred network so the machine can get *itself*
online, and that is all it should be trusted for. Guest networks routinely do
three things that break this install outright, and none of them can be tested
from here:

- **Client isolation.** Most guest SSIDs block device-to-device traffic. If it is
  on, *nobody* reaches the Mini from their laptop — not by name, not by IP. This
  one silently sinks the whole deployment while the server looks perfectly
  healthy from its own console.
- **No mDNS.** `mkmini.local` is a Bonjour name, and it is baked into
  `PAPERCLIP_PUBLIC_URL`, every invite link, and every password-reset link
  already issued. Guest VLANs commonly filter multicast. If mDNS is blocked those
  links are dead even though the box is reachable by IP.
- **Captive portals and rotating credentials.** A headless server cannot click
  "I agree", and many guest networks re-prompt daily or rotate the password.

So treat guest Wi-Fi as a fallback for outbound access only. What the install
actually needs is in the IT request above: a wired port on an internal VLAN, a
reserved address, and either mDNS permitted or a real DNS name.

### 2. Run the script

```
cd ~/agentdash && ./deploy/relocate.sh
```

**What it does**, in order, and why the order matters:

1. Finds the new LAN IP from the default route.
2. Rewrites `PAPERCLIP_ALLOWED_HOSTNAMES` in **both** env files.
3. Reissues the TLS certificate for the new IP.
4. Rewrites the Caddy site blocks and reloads.
5. **Restarts both instances**, because the hostname allow-set is read at boot.
6. Verifies every address with real certificate validation.
7. Prints the URLs and everything still missing.

Steps 2–5 have to happen in that order. Change the network without them and you
get a **403 at the hostname guard** — the server is running, healthy, and
refusing you, which looks like a much worse problem than it is.

No password needed. Restarting uses `kill -KILL`, because a graceful SIGTERM
exits 0 and `KeepAlive {SuccessfulExit: false}` will not restart a job that
exited cleanly — see "Restarting an instance". If either instance does not come
back, the script prints the `sudo launchctl kickstart` line to recover it.

### 3. Read the output

A green table of `200`s means reachable. It then prints the URLs and a
**"Before you tell anyone it is ready"** section. Take that section literally.

### 4. Open it

```
https://mkmini.local:3112              ← mkboard, the real workspace
https://mkthinks-mac-mini.tail112187.ts.net:3112   ← same, over Tailscale
```

There is one instance. The practice instance `uat` (3103/3113) was retired on
2026-08-18 and its ports no longer answer — if something is listening there,
something is wrong.

First visit shows a certificate warning until the CA is installed. That is
expected, not a fault.

---

## How you log in — read this before you drive over

The instance runs in `authenticated` mode. **There is no local bypass**, no
"admin console on localhost", no way in without a password. Exactly one account
exists on the real workspace:

```
titus@mkthink.com   admin   a password was set on 2026-08-12
```

That line records *that* a password exists, not what it is. **No credential is
written down in this repo or any other doc** — checked 2026-08-17 — and it should
stay that way. If you were counting on reading it here, see below instead.

**Password reset works as of 2026-08-17.** `RESEND_API_KEY` is now set on both
instances, and better-auth's `sendResetPassword` mails a real link
(`better-auth.ts:218-234`). Before that it silently no-opped, which is why this
section used to say there was no way back in.

### Getting Titus in — he sets his own password

You never need to know his password. One unauthenticated call mails him a link
that lets him set it himself:

```
curl -s -H 'Content-Type: application/json' \
  --data '{"email":"titus@mkthink.com","redirectTo":"/reset-password"}' \
  http://mkmini.local:3102/api/auth/request-password-reset
```

Returns `{"status":true,...}` — deliberately the same response whether or not the
address exists, so it tells you nothing about delivery. Confirm the send in the
log instead:

```
tail -5 ~/Library/Logs/agentdash/mkboard-server.log   # look for [email] sent
```

Proven on `uat` 2026-08-17: message `a37abf1f`, subject *Reset your AgentDash
password*, delivered.

**You can mint this before you travel.** Two reasons it survives the move:

- The URL host is `mkmini.local` — mDNS, so the name **follows the machine** and
  resolves on their office LAN exactly as it does on yours. That is why the
  Bonjour name was chosen over the DHCP address in the first place.
- Reset links on this box live **7 days**, not the 1 hour Better Auth defaults
  to (`AGENTDASH_RESET_TOKEN_TTL_SECONDS=604800`, capped server-side at 30 days).

So he still has to be **on their network** when he clicks — but not in the room
when you generate it.

### Handing the link over yourself

If you would rather give Titus the link in person than have it land cold in his
inbox, mint it without sending him anything. `capturePasswordResetUrl` registers
a resolver that `sendResetPassword` drains, so the email is never sent and the
URL comes back to you:

```
cd ~/agentdash/server
set -a && . ~/.config/agentdash/mkboard.env && set +a
pnpm exec tsx scripts/mint-reset-link.ts titus@mkthink.com
```

```
  link      http://mkmini.local:3102/reset-password?token=…
  for       titus@mkthink.com  (workspace 'mkboard')
  expires   2026-08-24T16:48:08.355Z

  No email was sent. Hand this over yourself.
```

**Sourcing the env file is not optional** — `DATABASE_URL` is what decides
whether you just minted a token against the real board or the practice one, and
the script prints which workspace it used so you can check. It reads the expiry
back out of the database rather than computing it, because the expiry that binds
is the row's, not what the email copy claims.

Done this way 2026-08-17: a 7-day token for Titus, expiring 24 Aug, and the
`mkboard` log confirmed no mail was sent to him.

If you would rather not deal with links at all, set the password yourself and
have him change it:

```
node ~/agentdash/deploy/set-password.mjs mkboard titus@mkthink.com
```

It prompts (never takes the password as an argument — that lands in `ps` and
shell history), uses better-auth's own hasher so the credential is exactly what
a normal sign-up would write, and **verifies the result with better-auth's own
checker** before saying it worked. Leave the prompt blank and it generates
something readable enough to say out loud.

Proven end to end on `uat` before it went near the real workspace: the right
password signs in **200**, the wrong one **401**.

## Getting other people in

Once you are in as Titus, everyone else goes through invites — and **only Titus
exists right now**. The stand-in accounts used for testing have been removed.

For each person:

1. Sign in as Titus → **Settings → People → Invite**.
2. Choose **member** unless they genuinely need to set company direction.
3. **The invite is emailed.** As of 2026-08-17 the invite route sends it via
   Resend from `AgentDash <invites@agentdash.cloud>`, and the response carries
   an `emailStatus` per invitee — `sent`, `skipped`, or `failed`. Copy the link
   anyway: the URL points at `mkmini.local`, so it only opens on their LAN or
   over Tailscale, and handing it over in person removes a step that can fail.
4. They open it, set a password, and they are in.
5. Install the CA on their machine, or every visit shows a warning:
   ```
   sudo security add-trusted-cert -d -r trustRoot \
     -k /Library/Keychains/System.keychain rootCA.pem
   ```

**Admin vs member matters and is enforced.** A member cannot set company
direction — verified, it returns 403, not a hidden button.

---

## What Titus will see

**The test data is gone.** Cleared 2026-08-17 with
`deploy/clean-test-data.mjs --apply`, read back from the database afterwards:

```
projects 0   users 1 (Titus)   synthetic context rows 0   agents 6
```

Removed: both test projects with their issues and comments, the six
`SEED — synthetic` company-context rows, and the two stand-in people. Kept: the
six agents, the company goal, and the four `MKT-1`–`MKT-4` issues, which
predate the testing and are yours.

So Titus opens a workspace with his six agents and a clean board. If you want
the RFP or board-pack runs back as a demo, they are described in
`doc/plans/2026-08-17-uat-result.md` and `2026-08-17-board-pack-result.md` and
can be re-run.

The containment-probe agents named **"Gate4 containment probe (delete me)"**
and **"Gate5 CEO probe (delete me)"** lived on `uat`, which was retired on
2026-08-18. They are gone with it; there is no longer a second port to avoid
screen-sharing.

---

## The reboot test — do this before you leave the building

This is the one thing that has never been proven, and the only thing that
matters after you drive away.

1. Reboot the Mini.
2. **Do not log in.** Leave it at the login window.
3. From another machine on their network:
   ```
   curl -sk https://mkmini.local:3112/api/health
   ```

A `200` means everything survives a power cut. Anything else means it needs
someone logged in, and it will die at the first outage. All seven LaunchDaemons
are configured to run at boot without a session, and Tailscale's daemon is too,
but **configured is not proven** — this is the proof.

**Proven at home 2026-08-17. It passes.** Boot at 08:14:56; postgres, Caddy and
tailscaled up at 08:15:17; both servers at 08:15:21; serving by 08:15:34 — about
38 seconds, with the console user still `root` at the login window. The first
SSH session did not happen until 08:16:36, a full 62 seconds *after* the stack
was already answering. Nothing needed a human. All four addresses returned 200
under real certificate validation.

Do it again on their network anyway — that run also proved it comes up on
**Wi-Fi**, which §1 warned might race the network, but their switch, their DHCP
and their DNS are all untested. See `doc/REBOOT-TEST.md` for the baseline.

---

## If something is wrong

Every file the script touches is backed up with a `.bak-<timestamp>` suffix in
`~/.config/agentdash/`. To roll back:

```
cd ~/.config/agentdash
cp mkboard.env.bak-<stamp> mkboard.env
cp Caddyfile.bak-<stamp>   Caddyfile
caddy reload --config Caddyfile
pkill -KILL -f 'tsx src/index.ts'      # -KILL, not -TERM: see "Restarting an instance"
```

Common cases:

| symptom | cause | fix |
|---|---|---|
| `403 Hostname ... is not allowed` | Servers did not restart | `pkill -KILL -f 'tsx src/index.ts'`, wait ~15s |
| An instance is down and stays down | It was stopped with SIGTERM | `sudo launchctl kickstart -k system/com.agentdash.<inst>.server` |
| TLS connection drops, no error page | No Caddy block for that address | Re-run `relocate.sh` |
| Reachable by IP, not by name | mDNS blocked on their network | Use the Tailscale name |
| Tailscale offline | Their firewall blocks it | It will fall back to a DERP relay; slower, still works |

Read errors at **Company → Settings → Errors** (not `/instance/errors` — the
first path segment is read as a company prefix).

---

## Say this, not that

**Do say:** run counts, wall-clock times, what the agents produced, who approved
what.

**Do not say** anything about cost. `cost_events` is empty — token metering is
not wired, so every spend figure is **unmeasured, not zero**. If asked: *"spend
tracking is the next thing we're finishing; I won't show you a number I can't
stand behind."* That is a better answer than a dashboard reading `$0.00`.

Also unproven, in case it comes up: the local-harness leg was demonstrated with
**Claude Code**, not Codex — Codex is not logged in on this machine. And
"Megan's laptop" in that run was a directory on the Mini, so a real second
machine over the network has not been tested.
