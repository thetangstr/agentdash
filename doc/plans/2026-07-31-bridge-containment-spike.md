# Bridge containment spike — results

**Date:** 2026-07-31
**Host:** MKThink Mac mini M4, macOS 26.6, arm64 (`yang@192.168.86.57`)
**Method:** decoy secret (`SPIKE_DECOY_SHOULD_NOT_BE_READABLE`), never real credentials.
**Question:** can the local bridge worker run agent-authored code on a staff Mac
without exposing the rest of the machine or the MKThink LAN?

**Answer: yes, at the OS layer. 16 of 16 tests behaved correctly.**

The Claude Code layer is **not yet validated** — the CLI on the mini is
unauthenticated. See "Still open".

## The profile that works

Whole-filesystem deny-by-default is **not viable** — it starves dyld and the
process dies on SIGABRT (exit 134) before `main`. The allowed work fails along
with the disallowed work, which is useless. The deployable shape inverts it:
allow the system, deny the human, re-open the workspace.

```scheme
(version 1)
(allow default)

;; Deny the operator's home, then re-open only the task workspace.
;; Order matters in SBPL: later rules win.
(deny file-read* file-write* (subpath "/Users/yang"))
(allow file-read* file-write* (subpath "/Users/yang/spike/workspace"))

;; Deny all egress, then re-open loopback only. A local proxy enforces the
;; domain allowlist; the sandbox guarantees nothing can bypass that proxy.
(deny network*)
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind    (local  ip "localhost:*"))
```

## What was verified

| # | Test | Expected | Result |
|---|------|----------|--------|
| 1 | read decoy in home | denied | ✅ |
| 2 | read inside workspace | succeeds | ✅ |
| 3 | write inside workspace | succeeds | ✅ |
| 4 | network egress | denied | ✅ |
| 5 | child process reads decoy | denied | ✅ |
| 6 | grandchild (nested shell) reads decoy | denied | ✅ |
| 7 | `python3` reads decoy | denied | ✅ |
| 8 | real `~/.ssh` listable | denied | ✅ |
| 9 | `node` reads decoy | denied (`EPERM`) | ✅ |
| 10 | `node` spawns shell to read decoy | denied | ✅ |
| 11 | `node` writes in workspace | succeeds | ✅ |
| 12 | `node` outbound `fetch` | denied | ✅ |
| 13 | loopback reachable (proxy shape) | succeeds | ✅ |
| 14 | egress to `api.anthropic.com` | denied | ✅ |
| 15 | egress to raw IP `1.1.1.1` | denied | ✅ |
| 16 | egress to LAN peer `192.168.86.1` | denied | ✅ |

The four that matter most:

- **Inheritance holds (5, 6, 10).** Confinement is not escapable by spawning a
  child. This is the property a `chdir`-and-hope approach never has.
- **Interpreters do not escape (7, 9).** Python and Node are subject to the same
  kernel checks as `cat`. There is no "but it's a scripting language" hole.
- **Raw-IP egress is denied (15).** Egress control does not depend on DNS, so an
  agent cannot bypass a domain allowlist by dialing an address directly.
- **LAN egress is denied (16).** A compromised task cannot pivot to other
  MKThink machines. This is the single most important line for the IT
  conversation — the blast radius stops at the workspace directory.

## Consequences for the design

**1. Total network deny and Claude Code are incompatible.**
`--dangerously-skip-permissions` is documented as "recommended only for sandboxes
with no internet access", but Claude Code must reach `api.anthropic.com` to
function at all. The two cannot both hold. Test 13 resolves it: deny all egress,
allow loopback, and put a local allowlisting proxy on loopback. The proxy decides
which domains are reachable; the sandbox guarantees nothing routes around it.
This is the only shape where "no unmediated internet" and "the agent runs" are
simultaneously true.

**2. The worker must `chdir` into the workspace before exec.**
With the home directory denied, `getcwd` fails if the process starts anywhere
inside it, and the shell emits
`error retrieving current directory: getcwd: cannot access parent directories`.
Harmless-looking, but it breaks tools that resolve relative paths. Set the
working directory as part of spawning, not as a first command.

**3. Seatbelt is one of two layers, not the only one.**
It constrains *subprocesses*. Claude Code's own `Read`/`Edit` tools are in-process
and answer to the permission system, not the sandbox. Both layers have to be
configured, and neither substitutes for the other.

## Follow-up: DNS, found while implementing the worker (2026-07-31)

`(deny network*)` also closes the **mDNSResponder socket**, so name resolution
dies with it. This is invisible in the table above because every egress test
there either used a raw IP or expected a denial.

It matters for the `direct` egress policy (`--egress direct`, allow outbound
443 with no proxy). Re-verified live against the profile the worker generates:

| Profile | Target | Result |
|---------|--------|--------|
| 443 allow only | `https://1.1.1.1/` (raw IP) | connects, HTTP 301 |
| 443 allow only | `https://api.anthropic.com/` | **`Could not resolve host`** |
| 443 allow + mDNSResponder | `https://api.anthropic.com/` | connects, HTTP 404 |
| 443 allow + mDNSResponder | `http://example.com/` (port 80) | denied |
| 443 allow + mDNSResponder | `192.168.86.1:22` (LAN) | denied |

So `direct` needs one more line, or it looks configured and does nothing:

```scheme
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
```

The **loopback** profile deliberately does not get this line. Under loopback the
task connects to `127.0.0.1` and the proxy resolves on its behalf, so the task
itself never needs DNS — and withholding it keeps the validated property that
nothing routes around the proxy. Egress widening stays confined to the policy
that opted into it.

## Still open

- **The Claude Code layer is unvalidated.** The CLI (2.1.212) is installed at
  `~/.local/bin/claude` but has no `~/.claude/.credentials.json`. Nothing about
  agent behaviour under sandbox has been demonstrated — only the OS floor
  beneath it. Requires an interactive login by the owner.
- **Whether `--print`/`-p` disables trust verification** in this build, and what
  that means for unattended runs.
- **Whether the operator's `~/.claude/settings.json` leaks into bridge runs**,
  and whether `--bare` (or equivalent) suppresses it.

## Provenance

Nothing was installed to run this spike. Files created, all under `~/spike/`
and all disposable: `secret-decoy.txt`, `workspace/`, `deny-default.sb` (the
failed shape, retained as evidence), `home-deny.sb`, `proxy-shape.sb`.
No `sudo`, no system modification, no configuration profile — consistent with
the standing constraint that nothing done now may conflict with later MDM
enrollment.
