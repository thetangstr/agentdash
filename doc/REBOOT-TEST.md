# The reboot test

The one thing configuration cannot tell you. Everything is *set up* to start at
boot without a session; nothing has ever *proven* it. This is the proof, and it
is the difference between a machine that survives a power cut in a server room
and one that quietly needs someone logged in.

Run it at home, with a keyboard and a monitor, not on site.

---

## Baseline, captured 2026-08-17 01:25 before the reboot

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
   http://192.168.86.57:3103/api/health     ← uat
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
