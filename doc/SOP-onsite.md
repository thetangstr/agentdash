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

| # | do | why |
|---|---|---|
| 1 | `./deploy/relocate.sh --check` at home | Confirms the script runs clean on a network you know. Changes nothing. |
| 2 | Copy the CA to a USB stick or somewhere you can reach it | `~/Library/Application Support/mkcert/rootCA.pem`. Without it, every browser shows a warning. |
| 3 | Decide about the test data — see **"What Titus will see"** below | Easier to decide now than in front of him. |
| 4 | `sudo scutil --set ComputerName "MKThink Mac Mini"` | Still says *yang's Mac mini* in Finder and AirDrop. Needs your password, so do it while you have a keyboard. |

---

## On site

### 1. Physical

Prefer **Ethernet** over Wi-Fi. It is currently on Wi-Fi (`en1`); a server in a
rack should not depend on a wireless association it cannot re-establish
unattended. The script detects whichever interface holds the default route, so
it does not care which you choose — but a reboot on Wi-Fi may come up before the
network does, and Ethernet removes that whole class of problem.

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

No password needed. Restarting uses `kill -TERM`, and launchd's `KeepAlive`
brings each instance straight back.

### 3. Read the output

A green table of `200`s means reachable. It then prints the URLs and a
**"Before you tell anyone it is ready"** section. Take that section literally.

### 4. Open it

```
https://mkmini.local:3112              ← mkboard, the real workspace
https://mkthinks-mac-mini.tail112187.ts.net:3112   ← same, over Tailscale
```

Port **3113** is `uat`, the practice instance. Only ever demo from **3112**.

First visit shows a certificate warning until the CA is installed. That is
expected, not a fault.

---

## Getting people in — the part no script can do

**Right now only Titus can sign in.** Sam and Megan exist in the database with
memberships, and **no password and no credential of any kind**. They cannot log
in, and nothing on screen says so until they try.

There are two open invites, but **their links cannot be recovered** — only a
hash is stored. If you do not still have those URLs, they are dead. Reissue.

For each person:

1. Sign in as Titus → **Settings → People → Invite**.
2. Choose **member** unless they genuinely need to set company direction.
3. **Copy the link.** Nothing is emailed — Resend is wired for error alerts
   only, not for invites. You hand the URL over yourself.
4. They open it, set a password, and they are in.
5. Install the CA on their machine, or every visit shows a warning:
   ```
   sudo security add-trusted-cert -d -r trustRoot \
     -k /Library/Keychains/System.keychain rootCA.pem
   ```

**Admin vs member matters and is enforced.** A member cannot set company
direction — verified, it returns 403, not a hidden button.

---

## What Titus will see, and a decision to make first

The real workspace is **not empty**. It contains last night's two test runs:

- **"RFP response — Lakeway TX civil engineering"** — three agents, a real
  approval, and honest refusals to fabricate.
- **"Board pack — week of 17 Aug 2026"** — the laptop-bridge run, where a
  confidential figure reached the board only after Megan approved it.
- **6 synthetic company-context rows**, each labelled `SEED — synthetic ... NOT
  real MKThink project history`.

Both stories are genuinely good demo material, and the labelling is honest. But
decide **before** you show anyone whether you want them there, because
"why does our board think we have a water campus project" is a bad question to
field live. Delete the synthetic context rows if in doubt; the projects
themselves are worth keeping.

The `uat` instance also has two agents literally named **"Gate4 containment
probe (delete me)"** and **"Gate5 CEO probe (delete me)"**. Do not screen-share
3113.

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

---

## If something is wrong

Every file the script touches is backed up with a `.bak-<timestamp>` suffix in
`~/.config/agentdash/`. To roll back:

```
cd ~/.config/agentdash
cp mkboard.env.bak-<stamp> mkboard.env
cp uat.env.bak-<stamp>     uat.env
cp Caddyfile.bak-<stamp>   Caddyfile
caddy reload --config Caddyfile
pkill -TERM -f 'tsx src/index.ts'
```

Common cases:

| symptom | cause | fix |
|---|---|---|
| `403 Hostname ... is not allowed` | Servers did not restart | `pkill -TERM -f 'tsx src/index.ts'`, wait 15s |
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
