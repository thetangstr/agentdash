# The reboot test

The one thing configuration cannot tell you. Everything is *set up* to start at
boot without a session; nothing has ever *proven* it. This is the proof, and it
is the difference between a machine that survives a power cut in a server room
and one that quietly needs someone logged in.

Run it at home, with a keyboard and a monitor, not on site.

---

## Baseline, captured 2026-08-17 01:25 before the reboot

> Recorded when this machine ran two instances. `uat` (3103/3113) was retired on
> 2026-08-18, so the current pass condition is `daemons loaded : 5` and the
> :3103/:3113 lines should be absent. The figures below are left as captured —
> a baseline that is edited after the fact is not a baseline.

```
daemons loaded : 7
http  :3102    200      http  :3103    200
https :3112    200      https :3113    200
tailscale      100.64.89.16
LAN            192.168.86.57
in-flight runs 0
```

That is what "passed" looks like. Anything less is a finding.

---

## Result, 2026-08-17 08:14 — PASS

```
daemons loaded : 7   (4 running, 3 calendar-triggered and correctly idle)
http  :3102    200      http  :3103    200
https :3112    200      https :3113    200      <- real CA validation, not -k
tailscale      100.64.89.16   up, daemon started at boot
LAN            192.168.86.57
in-flight runs 0     (no pending/running rows in any run/job table)
```

The part that actually matters is the ordering:

```
08:14:56  boot
08:15:17  postgres, caddy, tailscaled
08:15:21  both servers
08:15:34  DB connections live — serving, ~38s after boot
08:16:36  first SSH login — 62s LATER
```

`stat -f '%Su' /dev/console` returned `root` and `loginwindow` was at the login
screen throughout, so no user session existed when the stack came up. That is
the whole claim, and it holds.

Two things learned in the same session, both worth more than the pass:

- **It came up on Wi-Fi.** SOP §1 warns a reboot on `en1` may beat the network.
  It did not, once. One sample on a network we control — not evidence about
  theirs.
- **`kill -TERM` does not restart an instance.** Unrelated to boot (that is
  `RunAtLoad`), but it was the documented restart mechanism and it was wrong.
  See "Restarting an instance" in `SOP-onsite.md`.

---

## Do this

1. **Reboot.**
   ```
   sudo shutdown -r now
   ```

2. **Do not log in.** Leave it sitting at the login window. This is the entire
   point — logging in would start the user session that the test exists to
   prove is unnecessary.

3. **Wait about two minutes.** Postgres has to come up before the two servers
   will answer, and they retry.

4. **From another device on the same network** — your laptop, or a phone on the
   Wi-Fi:

   ```
   http://192.168.86.57:3102/api/health     ← mkboard
   ```

   Plain HTTP on purpose: your phone does not have the mkcert root installed,
   and a certificate warning would tell you nothing about whether the service
   booted.

   If your phone has Tailscale, `http://100.64.89.16:3102/api/health` also
   proves the Tailscale daemon came up without a session, which is worth
   knowing separately.

---

## Reading the result

| what you see | means |
|---|---|
| `{"status":"ok"...}` on both | **Pass.** The stack survives a power cut unattended. |
| Connection refused | A daemon did not start. Log in and read the logs below. |
| One port answers, the other does not | One instance failed; postgres is fine. |
| Nothing at all, no ping | The machine did not come back, or the network did not. |

## If it fails

Log in — at that point the test has already told you what it needed to. Then:

```
launchctl print system | grep agentdash        # are all 7 loaded?
tail -50 ~/Library/Logs/agentdash/mkboard-server.log
tail -50 ~/Library/Logs/agentdash/postgres.log
```

The most likely cause is ordering: a server starting before postgres is
accepting connections. `KeepAlive` should retry it, so a service that is
*loaded* but not *answering* after five minutes is a real fault rather than a
slow start.

Then re-run the whole check with:

```
cd ~/agentdash && ./deploy/relocate.sh --check
```
