# Agent sandbox: what confines an agent run, and what does not

*Recorded for AGE-7 (Chris review). Measurements below were taken on an isolated
test instance with a disposable company on 2026-09-01, CEO-approved in-thread;
no live company and no customer instance was read or changed.*

## The control surface

Agent subprocesses are confined by macOS Seatbelt, controlled entirely by four
environment variables read once at server startup
(`server/src/services/agent-sandbox-config.ts`):

| Variable | Meaning | Default |
|---|---|---|
| `AGENTDASH_AGENT_SANDBOX` | `off`, `loopback` (egress denied except loopback), or `direct` (outbound 443 re-opened) | **`off`** — agents run unconfined |
| `AGENTDASH_AGENT_SANDBOX_ALLOW` | colon-separated absolute paths re-opened **read-write** below the home deny | unset |
| `AGENTDASH_AGENT_SANDBOX_READONLY` | colon-separated absolute paths re-opened **read-only (and executable)** — the agent's own runtime | unset |
| `AGENTDASH_AGENT_SANDBOX_HOME` | a synthetic `HOME` for the subprocess, so tools that probe `$HOME` miss instead of reading the operator's config | unset |

Off by default is deliberate: turning it on changes how every agent on the host
runs, and the first thing it does is reveal which runtime paths the agent CLI
needs outside its workspace. The startup log states the posture on every boot,
including when it is off.

A typo in `AGENTDASH_AGENT_SANDBOX`, a non-macOS host, or a synthetic home that
is the operator's real home (or an ancestor of it) refuses to start rather than
silently running unconfined. Those refusals are tested in
`agent-sandbox-config.test.ts`.

## What "approvals" means here

Paperclip's approvals are **task-scoped**: a per-issue `executionPolicy` with
`review` / `approval` stages and an always-on comment-required backstop. There
is no per-turn or per-tool prompt anywhere in the harness.

`dangerouslyBypassApprovalsAndSandbox`, `dangerouslyBypassSandbox` and
`dangerouslySkipPermissions` — including
`DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX = true` — are **codex-local's**
flags. They configure the Codex CLI's own permission prompts inside a Codex run.
They have no effect on `hermes_local`, which is not a first-party adapter (it
runs through the external `hermes-paperclip-adapter`), and they are not what
governs whether an AgentDash agent may read a file or reach a host.

For every adapter, the boundary that binds is the Seatbelt profile above, when
it is on. When it is off, nothing confines the subprocess but the agent's
credentials and the company-scoped API.

## hermes_local: the measured minimum confinement

Upstream documents `~/.hermes` read-only as the entry the Hermes runtime needs.
On this machine that is **necessary but not sufficient**:

| Attempt | Result | Cause |
|---|---|---|
| `loopback` + `~/.hermes` read-only | exit 1 (`venv/bin/hermes: Undefined error: 0`) | the venv's `python3` is a symlink out of `~/.hermes` to `~/.local/share/uv/python/…/bin/python3.11`, still inside the home deny |
| + `~/.local/share/uv/python` read-only | exit 0, then `Failed to initialize SessionDB` | Hermes needs a writable location; the runtime is deliberately read-only |
| + synthetic `HOME` on a scratch directory | **succeeded**, exit 0 | — |

So the working setting for a Hermes agent is:

```sh
AGENTDASH_AGENT_SANDBOX=loopback
AGENTDASH_AGENT_SANDBOX_READONLY=$HOME/.hermes:$HOME/.local/share/uv/python
AGENTDASH_AGENT_SANDBOX_HOME=/path/to/a/dedicated/agent-home
```

Both read-only entries are the interpreter; neither is ever re-opened
read-write, so a run cannot rewrite the runtime that later runs use.

## The boundary, measured against the generated profile

Probed with `sandbox-exec` against the profile `buildSandboxProfile` emits
(`(deny network*)` plus loopback allows), with real exit codes:

| Probe | Result |
|---|---|
| external `https://api.z.ai` | denied |
| loopback (the instance's own port) | allowed |
| read `~/.zshrc` | denied |
| read `~/.config/agentdash/*.env` | denied |
| read the instance's `secrets/master.key` | denied |
| read the Hermes runtime (read-only entry) | allowed — intended |
| write the workspace | allowed — intended |
| write the Hermes runtime | denied |
| write the operator's home | denied |

Every restricted read and every write outside the workspace was refused. No new
user, membership, agent, routine or assignment appeared on either instance
during the exercise; the disposable company was deleted afterwards.

One correction worth keeping: the first filesystem pass reported everything
allowed. That was the test harness (a `| head` that always exited 0), not the
sandbox. Re-run with real exit codes, every boundary held. A security test that
cannot fail is worse than none.

## What remains open

- **AGE-33** — a confined `hermes_local` run that completes a real model turn
  (usage non-null). Exec and exit were proven; the end-to-end turn was not.
- The default stays `off`. Turning confinement on for an instance is an
  operator decision with the two read-only paths above; it is not flipped by
  a release.
