# AgentDash Runbook

For the person who owns this machine, not the person who built it.

Everything runs on one Mac mini (`mkmini`). Two separate copies of the app:

| Name | What it is | Plain address | Secure address |
|---|---|---|---|
| **mkboard** | The real MKThink workspace. This is the one that matters. | http://127.0.0.1:3102 | https://mkmini.local:3112 |
| **uat** | A practice copy. Safe to break. | http://127.0.0.1:3103 | https://mkmini.local:3113 |

All commands below are run in Terminal on the Mac mini, logged in as `yang`.
None of them need an administrator password.

> **Heads up about the secure addresses.** The `https://` links work, but your
> browser will show a "not private" / "not trusted" warning first. That is
> expected on this setup — the security certificate is self-issued and was never
> added to any machine's trusted list. Click through the warning. It is not a
> sign that anything is broken.

---

## 1. Is it healthy?

Paste this whole block into Terminal and press Return:

```sh
for s in postgres mkboard.server uat.server caddy; do printf "%-16s %s\n" "$s" "$(launchctl print system/com.agentdash.$s 2>/dev/null | awk '/^\tstate = /{print $3}')"; done; for p in 3102 3103; do printf "%-16s %s\n" "health $p" "$(curl -s --max-time 5 http://127.0.0.1:$p/api/health | sed 's/.*"status":"\([a-z_]*\)".*/\1/')"; done
```

**Healthy looks exactly like this** — six lines, all `running` or `ok`:

```
postgres         running
mkboard.server   running
uat.server       running
caddy            running
health 3102      ok
health 3103      ok
```

What the answers mean:

- **`running` / `ok`** — fine, nothing to do.
- **blank, or `not running`** — that service is down. Go to section 2.
- **`degraded`** — the app is up and serving people, but something needs
  attention soon. It is *not* an emergency. Causes, in order of likelihood:
  the nightly backup is more than 26 hours old; the disk has less than 5 GB
  free; or a piece of agent work has been stuck for more than 2 hours.
- **`unhealthy`** — the app cannot reach its database. Restart `postgres`
  (section 2), then `mkboard.server` and `uat.server`.
- **nothing printed for a health line** — the app did not answer at all.
  Treat it as down and go to section 2.

One thing worth knowing: a `degraded` answer still returns a normal "success"
code to anything that checks the address. **Read the word, not the colour.**

---

## 2. Restarting one service

There are seven background services. You almost never need the last three:

| Service name | What it does |
|---|---|
| `com.agentdash.postgres` | The database. Everything depends on this. |
| `com.agentdash.mkboard.server` | The real workspace. |
| `com.agentdash.uat.server` | The practice copy. |
| `com.agentdash.caddy` | Serves the `https://` addresses. |
| `com.agentdash.mkboard.backup` | Nightly backup, 03:30. |
| `com.agentdash.uat.backup` | Nightly backup, 03:30. |
| `com.agentdash.rotate-logs` | Tidies log files, 04:15. |

To restart one, put its name on the end of this command:

```sh
launchctl kickstart -k system/com.agentdash.mkboard.server
```

It prints nothing when it works. Wait about 20 seconds, then re-run the health
check in section 1.

**If the database is the problem, restart it first and on its own**, then
restart the two servers afterwards — they cannot start properly without it.

If that command ever answers `Operation not permitted`, put `sudo` in front and
enter the Mac's password.

**The other way.** Every one of these services is set to come back
automatically if it stops. So simply killing a stuck app also works — it will
restart itself within about 15 seconds:

```sh
pkill -f 'tsx src/index.ts'
```

Be aware that this restarts **both** mkboard and uat together, so prefer the
`kickstart` command above when you only want to touch one.

There is a deliberate 15-second minimum between restarts. If you restart
something twice in a row very quickly, the second one waits. That is normal.

---

## 3. A service keeps restarting

Symptom: the health check keeps flipping between `running` and blank, or the
site loads for a second and then dies.

First, find out how many times it has restarted:

```sh
launchctl print system/com.agentdash.mkboard.server | grep -E 'runs|last exit code'
```

A `runs` number climbing every 15 seconds means it is in a restart loop. (When
a service is healthy you may see only the `runs` line — the exit code appears
once something has actually failed.) Now look at why:

```sh
tail -n 40 ~/Library/Logs/agentdash/mkboard-server.log
```

The two failures that stop it starting at all:

- **`last exit code = 78`** and a line reading `no env file at ...` — its
  settings file is missing or was moved. The settings live in
  `~/.config/agentdash/`. **Do not open these files, print them, or paste their
  contents to anyone** — they hold passwords and keys. This one needs Yang.
- **`last exit code = 69`** on the *postgres* service — the database program
  itself is missing from the machine. This needs Yang.

Either of those will retry forever without ever succeeding. Restarting again
will not help. Stop and call for help rather than repeating the restart.

If the log shows `ECONNREFUSED 127.0.0.1:54329`, the servers are fine and the
**database** is what is actually down. Restart `com.agentdash.postgres` first.

---

## 4. When an agent fails

Agents run as separate, deliberately fenced-in programs. Three places to look,
in this order:

**1. The error page.** Sign in as an administrator and go to:

```
https://mkmini.local:3112/MKT/company/settings/errors
```

(Use `:3113` for the practice copy.) This lists what broke and whether anyone
was told about it. Only administrators can open it. On a good day it is empty.

**2. The log.**

```sh
tail -n 100 ~/Library/Logs/agentdash/mkboard-server.log
```

**3. The fencing.** Agents are restricted to a small set of folders. If an
agent fails complaining that it cannot read or write a file, that restriction
is the likely reason — and it is doing its job. The exact list of folders an
agent is allowed to touch is printed every time the server starts. Find it
with:

```sh
grep 'agent subprocess sandbox' ~/Library/Logs/agentdash/mkboard-server.log | tail -1
```

Anything not named in that line is off-limits to agents by design. Widening it
is a decision for Yang, not a fix to apply under pressure.

---

## 5. Backups and restoring

**Backups are running.** Every night at 03:30, both copies are saved to:

```
~/.paperclip/backups/mkboard/
~/.paperclip/backups/uat/
```

Check that last night's backup arrived:

```sh
ls -lt ~/.paperclip/backups/mkboard/ | head -3
```

You should see a file dated today with a size in the hundreds of kilobytes. A
file of a few hundred bytes means a failed backup. Roughly a year of history is
kept (two weeks of nightlies, then weekly, then monthly).

### Restoring — read this before you need it

> **There is no one-command restore on this machine today, and you should not
> attempt one under pressure. Call Yang.**

Being straight with you about where this stands, because finding out during a
real emergency would be much worse:

- **Your data is safe and the backup files are good.** This was tested on
  16 August 2026: the most recent mkboard backup was loaded into a scratch
  database and the contents came back complete and matching the live system.
  Nothing is silently corrupt.
- **But the built-in restore command does not work on these files.** It fails
  partway through with a `syntax error` message. Putting the data back
  currently takes a hand-run script and someone who knows the system.

So: the backups are worth having and will get your data back. Recovery just is
not yet a button you can press yourself. **Do not delete or move anything in
the backup folders** while waiting for help.

If a restore is needed, tell Yang which copy (mkboard or uat) and which date,
and leave everything else alone.

---

## 6. Logs

Everything writes to `~/Library/Logs/agentdash/`:

| File | Which service |
|---|---|
| `mkboard-server.log` | The real workspace |
| `uat-server.log` | The practice copy |
| `postgres.log` | The database |
| `caddy.log` | The `https://` addresses |
| `mkboard-backup.log`, `uat-backup.log` | Nightly backups |
| `rotate.log` | The nightly log tidy-up |

They are tidied automatically at 04:15 each night: any log over 10 MB is
compressed and started fresh, keeping the last 5. You do not need to delete
logs by hand, and the disk will not fill up with them.

To watch a log live while you restart something, use `tail -f` and press
`Control-C` to stop:

```sh
tail -f ~/Library/Logs/agentdash/mkboard-server.log
```

---

## 7. Who to call

**Yang — built and installed all of this.**
Email: yang@mkthink.com
Phone: _______________________

Call Yang for anything in these categories, without trying to fix it first:

- Restoring a backup (section 5).
- Exit code 78 or 69 — a missing settings file or missing program (section 3).
- Anything involving the files in `~/.config/agentdash/`.
- A service still restarting in a loop after you have looked at the log once.

Automatic alert emails go to the address configured on this machine as
`AGENTDASH_ALERT_TO`. If alerts stop arriving, that is itself worth reporting.

### Before you call, grab this

Run the health check from section 1 and copy the six lines, plus:

```sh
tail -n 30 ~/Library/Logs/agentdash/mkboard-server.log
```

That is almost always enough to work out what happened.

---

## The two rules

1. **uat is the practice copy — experiment there, not on mkboard.**
2. **Restarting is safe. Deleting is not.** Restarting any service on this
   page is harmless and loses nothing. Deleting files, especially in
   `~/.paperclip/backups/` or `~/.config/agentdash/`, can be permanent.

---

*Written 16 August 2026. Every command here was run on this machine and does
what it says. The restore gap in section 5 is real as of that date — if it has
since been fixed, this page needs updating.*
