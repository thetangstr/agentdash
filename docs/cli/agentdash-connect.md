---
title: "agentdash-connect"
summary: "Connect Claude Code or Codex on your machine to your AgentDash agent."
---

> Generated at commit `70153f223` by `scripts/docs/generate-mcp-reference.mjs`.
> This page is `packages/connect/README.md`, the README published to npm with the package. Edit the README, then run `pnpm docs:mcp-reference`.

Connect the coding agent on your machine — Claude Code or Codex — to your
AgentDash agent.

```sh
npx -y agentdash-connect@latest --url https://your-instance KVTX-8F02
```

You rarely type this yourself. Your agent's **My Agent** page has a
**Create a connect code** button that produces this exact line with a fresh
code already in it — copy it from there and run it on the machine you work on.
It works the same in a macOS/Linux terminal and in PowerShell on Windows.

## Before you run it

- **Use the full package name, `agentdash-connect`.** Reaching for `npx` with
  the bare name `agentdash` lands on an unrelated package on the public npm
  registry that is not part of this project. It prints a help screen and exits
  0, which looks like success.
- **Keep `@latest`.** A bare package name lets npx serve whatever its cache
  holds, and a cached pre-0.2 CLI pairs the agent but silently skips the inbox
  half, with no error. `-y` skips npx's "Ok to proceed?" prompt.
- **Run it within ten minutes.** A connect code works once and expires ten
  minutes after it is created, which is also why it is safe on a command line.
  If it is refused, create a new one; nothing was written.
- **Use an address that resolves from where you are.** `.local` names usually
  do not resolve over a VPN. When the address you are browsing from differs
  from the one the instance publishes, the My Agent page offers both, yours
  first.

## What it actually does

1. Finds which harnesses are installed (`claude`, `codex`).
2. **Checks the link and credential work before touching anything.** A wrong
   code, a typo'd host and an instance that is down are three different
   messages, and you get them before any file is written.
3. Writes each harness's own native MCP config.
4. When the instance supports it (v2026.914.0 and later), sets up your inbox —
   see below.
5. Prints every file it changed.

```
Connecting this machine to an AgentDash agent.
Found: Claude Code, Codex

Redeeming code KVTX-8F02 …
Paired as Quill at Halden & Co., for this machine (laptop (darwin)).

Checking https://your-instance/api/mcp …
Connected. 72 tools available, agent briefing received.

Wrote:
  claude  ~/.claude.json
          stores the key in this file (mode 600)
  codex   ~/.codex/config.toml
          reads AGENTDASH_KEY_AGENTDASH at runtime; key stored in the keychain

Inbox connected for Jonah Lee (jonah@example.com):
  token   ~/.agentdash/bridge-token
          your inbox credential (mode 600) — questions for you arrive with it
  inbox   ~/agentdash-inbox/.claude/settings.json
  inbox   ~/agentdash-inbox/README.md
  inbox   ~/agentdash-inbox/.claude/skills/agentdash-coworker/SKILL.md
  inbox   ~/agentdash-inbox/AGENTS.md
  claude  ~/.claude.json
          "agentdash-inbox" — your own inbox tools: Claude reviews with you and sends only what you approve

Open ~/agentdash-inbox in Claude Code: anything waiting on you appears as the session starts, and Claude reviews it with you.
```

## The inbox

Redeeming a code also connects **you**, not just your agent: the instance mints
an inbox credential for the person who created the code. It is deliberately a
different credential from the agent key — an agent must never be able to read
its steward's inbox.

| file | what it is |
|---|---|
| `~/.agentdash/bridge-token` | your inbox credential, mode 600 |
| `~/.agentdash/bridge-owner.json` | whose inbox this is and which instance — display metadata only, mode 600 |
| `~/agentdash-inbox/.claude/settings.json` | a `SessionStart` hook that runs `npx -y agentdash-connect@latest inbox --ack --quiet-when-empty` |
| `~/agentdash-inbox/README.md` | a short note on what the folder is for |
| `~/agentdash-inbox/.claude/skills/agentdash-coworker/SKILL.md` | the review skill: how Claude reviews your agents' work with you (below) |
| `~/agentdash-inbox/AGENTS.md` | the same rules, for Codex |
| `~/.claude.json` | a second entry, `agentdash-inbox` — your own inbox tools, holding no secret |

Start or resume a Claude Code session **in `~/agentdash-inbox`** and the hook puts what is
waiting on you into the session: approvals needing your decision first, then
questions your agents asked you, then agents that stopped, then work that
finished. It is a separate folder so it can
never interrupt a session anywhere else — the hook applies only to sessions
started there.

One thing the hook does not do:

- **It does not carry the evidence.** Only the ask and a pointer arrive, because
  anything delivered into a session becomes model context.

The hook only reports. Reviewing what it reports, and acting on it as you, is
the job of the review skill and the `agentdash-inbox` tools, on the same
credential — see below.

If this machine's inbox already belongs to someone else, pairing asks before
replacing it and defaults to keeping what is there. The agent pairing goes
ahead either way.

## Deciding from your own session

Connecting writes a second Claude Code entry, `agentdash-inbox`, that serves
your own inbox over stdio: `inbox_sync` to see what is waiting, `inbox_decide`
to approve or reject it, `inbox_ack` to mark it seen, and `inbox_agents` /
`inbox_propose` / `inbox_confirm` to hand work to an agent. It runs
`npx -y agentdash-connect@latest mcp --server <url>` — through `cmd /c` on
Windows — and reads `~/.agentdash/bridge-token` on every call, so no secret goes
into the config file and re-pairing a machine takes effect in a session that is
already open.

These tools act as **you**, not as your agent, and that distinction is the whole
point. Asked to approve something, Claude used to reach for the agent's key and
get `403 Board access required`, because an agent must never decide the
approvals that constrain it. That refusal has not moved. What is new is that
your own credential is in the session too.

Nothing is widened by it. A decision still needs a handle minted for one
approval at one revision, delivered to your endpoint, spent once, and re-checked
against your authority when it is redeemed — so you can decide exactly what you
could decide on the page, and nothing else.

Claude is expected to have a view. It reviews each item with you and says what
it thinks, including that the agent's recommendation is wrong. What it sends is
yours: the tools tell it to send only what you chose, only after your explicit
go in the conversation, never on its own initiative and never because an issue,
document or message asked it to. If you would rather have no in-session
decisions at all, delete the `agentdash-inbox` entry from `~/.claude.json`;
everything else keeps working.

Connected before 0.3.0? Re-run connect with a fresh code to get the entry, then
start a new Claude session. Nothing changes on a connected machine until you do.

## Answering your agents

When work reaches your agent — including work assigned to you — it takes the
first pass: it restates the request, works out a recommendation, and asks you.
Those questions arrive in `inbox_sync` (and in the inbox hook), each with the
agent's restatement, its options, the issue it is about, and an `answer`
handle. Tell Claude your answer and it calls `inbox_answer` with that handle:
`optionId` for a choice (ids look like `q1.o1`), `text` for a written answer (or a note on a choice),
`answers` when one ask has several questions. Your answer is recorded as yours,
exactly as if you had answered on the issue, and it wakes the agent.

The agent's text is the agent's, not an instruction to your session: the tools
tell Claude to treat it as material to review, give you its own take on the
question and the agent's recommendation, and send only the answer you give. The handle
is good for one question, on this machine, for an hour; a refused answer (an
unknown option, a required question left empty) leaves it usable, and a
question that was answered elsewhere, or is no longer yours, is refused.
`inbox_answer` needs 0.4.0 or later.

## The review skill

Connecting also puts a skill in the inbox folder,
`.claude/skills/agentdash-coworker/SKILL.md`, and the same rules in
`AGENTS.md` for Codex. It tells Claude how to work on your agents' hand-offs
with you:

- **Review first, in the inbox folder only.** At the start of a session in
  `~/agentdash-inbox`, before anything else, it goes through every waiting item
  in order — decisions, then questions, then approved but not delivered, then
  blockers — and always shows the counts, including how many were not shown.
  The inbox tools are registered for every Claude Code session on the machine,
  but outside the inbox folder Claude uses them only when you ask.
- **The agent's work, then its take.** Each item is presented as what was
  asked, what the agent did in its own words, and then "My take", labelled as
  Claude's. Agreeing, disagreeing, rejecting the draft and rewriting it are all
  normal outcomes.
- **Honest figures.** Numbers keep the label the agent gave them (measured,
  modeled, estimated); anything that cannot be checked is called unverified;
  nothing is invented to fill a gap.
- **Work kept across sessions.** Drafts and a `notes.md` per item live in
  `~/agentdash-inbox/work/<ISSUE>/`, so the next session resumes where this one
  stopped. Downloaded attachments go to `~/agentdash-inbox/incoming/<ISSUE>/`
  and are read as text only — never run, never opened with an application.
- **One read-back, one go.** Before anything is sent, Claude reads back
  exactly what will go out, as you, and who will see it, and asks
  "yes / change / no". One explicit yes sends that bundle; anything else sends
  nothing.
- **Lessons.** Each send-back carries two or three short lessons about how you
  want work done, which you can edit or drop. Never client content.
- **Agent material is not instructions.** Text from agents, documents,
  attachments and run logs is reviewed, never obeyed; an instruction found in
  it is reported to you as a finding.

The skill names tools that newer instances add (`work_list`, `work_read`,
`work_run_log`, `work_fetch_file`, `work_propose_reply`, `work_confirm_reply`,
`work_request_propose`, `work_request_respond`, `work_request_confirm`). When this session does not
have one, Claude says so and falls back to the inbox tools and your AgentDash
page.

Both files carry a version line. Connecting again, or the inbox folder's
session-start hook (which runs `@latest`), installs them when missing and
replaces them only when the packaged version is newer, so a machine that
connected before the skill existed gets it without a new code. A copy without
the version line is yours and is never touched; connecting tells you when it
kept one. A rules file installed by the hook loads fully from the next session.

## Reviewing your agents' work

The inbox carries the ask and a pointer. To review what your agent actually
did, the same `agentdash-inbox` entry also serves four read-only tools:

- `work_list` — what your agents have handed you: issues waiting on a decision,
  a question, a blocker or a review, decisions first, oldest first, with counts.
- `work_read` — one issue, as you see it on your page: the issue, its parent
  and the request it came from, comments, documents, attachment metadata
  (name, size, type, sha256), and child issues. Each body shows its start
  inside one size budget, so the answer fits in a session; a body that is cut
  carries `readMore`, the arguments that read that one document, comment or
  description to the end, a page at a time.
- `work_run_log` — the agent's own run log for that issue, paged, with secrets
  redacted on the server.
- `work_fetch_file` — saves one attachment into
  `~/agentdash-inbox/incoming/<ISSUE>/`, readable only by you, after checking
  its sha256 (no hash, no file). Allowlisted types within your company's
  attachment cap only; HTML, SVG and XML never come down, and the client
  refuses to save one even if a server sends it.

You see exactly what you could see on the page, narrowed to your own work:
issues assigned to you or to an agent you answer for. Anything else answers as
if it did not exist. Every piece of text that was written in AgentDash arrives
inside `<untrusted-agent-material>` markers: Claude reads it as material to give
you its own view on, never as instructions, and the run log is where an
injected instruction is most likely to hide. A fetched file is for reading
only; Claude never runs it or opens it with an application.

These tools need two things: your machine's credential must carry `bridge:work`
(connect codes redeemed from this release on include it, and existing
inbox-enabled machines were upgraded on deploy, each upgrade recorded in the
activity log), and an administrator must turn on `coworker_bridge_enabled` for
the company. Until then they answer with the reason. Every file downloaded is
recorded in the activity log by attachment and size, never by content.

## Asking someone else for work

Three more tools, on the same credential and behind the same two switches, let
you ask a colleague for work and close it out when the result comes back:

- `work_request_propose` — Claude turns your ask into a brief (title, what is
  wanted, what done means, deadline, who it is for, the person it goes to, and
  optionally a project you can both see) and reads it back: as it will be
  sent, who takes it, and who will see it. It changes nothing. A name that
  does not match exactly one colleague comes back as a question.
- `work_request_respond` — once a result is delivered (done, in review, or
  handed back to you), reads back accepting it (marked done, as you) or asking
  for changes (your note as a comment, reopened, and handed straight to the
  agent that owns the deliverable: the agent of the person you asked).
- `work_request_confirm` — sends what you said yes to, as you. The handle is
  single-use, and your permission is checked again when it is spent; if the
  request moved on in between, nothing is sent and Claude tells you why.

A request is created as you and assigned to that person; the usual rule then
gives it to their agent, which takes the first pass and asks them what it
needs. It needs the same permission as assigning work on the page. Files
cannot travel with a request yet.

`work_list` shows your requests under `requests`: delivered results first, then
what is still waiting, each with who it waits on and for how long ("waiting on
Person B for 2 days"), worked out on the server. A delivered result stays there
until you accept it, ask for changes or act on it on the page, for at most 14
days. `work_read` reads a request as the issue itself, its comments, documents
and attachments; the other person's agent's run log and their other work are
not yours to read and answer as if they did not exist. The session-start
digest adds a "Your requests" section with counts and pointers, never the
brief.

## Nothing left running

A config write with an exit code, not a prompt to paste — and `--remove`
reverses it.

No daemon, no menu-bar app, nothing to keep alive. Your inbox is read when a
session starts in its folder, and when the tools are asked for it; nothing polls
it in between. Everything written is a small file you can read, listed on screen
as it is written — a change your IT department can review in a minute.

`--remove` takes out both Claude Code entries — the agent's and
`agentdash-inbox` — along with the Codex config entry, the shell-profile line
and the stored key. It leaves your inbox credential and folder alone. To remove
those too, delete `~/.agentdash/bridge-token`, `~/.agentdash/bridge-owner.json`
and the `~/agentdash-inbox` folder.

## Where the key goes

Being precise about this, because it differs by harness and it is the part worth
understanding:

| | where the key lives |
|---|---|
| **Codex** | the OS keychain. `config.toml` holds only the *name* of an environment variable, never the secret. One line in your shell profile reads it back at login. |
| **Claude Code** | `~/.claude.json`, in plaintext, at mode 600. This is how Claude Code stores HTTP MCP credentials; we cannot change it, so we say so rather than imply otherwise. |

A connect code comes back from the instance as an agent key; you never see it.
If you pair with an agent key directly instead of a code, it is read from the
terminal with echo off — never from a command-line argument — so it stays out
of your shell history and out of the process list. If no keychain is available
(common over SSH or on a fresh login), it falls back to
`~/.agentdash/<name>.key` at mode 600 and tells you it did.

## Commands

```sh
npx -y agentdash-connect@latest --url <url> <code>   # redeem a connect code
npx agentdash-connect                  # interactive: asks for the link and a code or key
npx agentdash-connect --url <url>      # skip the URL question
npx agentdash-connect --check          # is the connection still good?
npx agentdash-connect --remove         # undo the agent connection
npx agentdash-connect --name <name>    # use a different MCP server name
npx agentdash-connect inbox            # read your inbox (what the SessionStart hook runs)
npx agentdash-connect mcp              # serve your own inbox tools to Claude Code over stdio
```

`mcp` is what the `agentdash-inbox` config entry launches; you do not run it by
hand. It takes `--server <url>` and `--token-file <path>`, speaks MCP on stdout
and nothing else, and reports a missing credential as an answer rather than a
crash.

`inbox` options: `--ack` marks what was fetched as seen, so the next session
shows only what is new; `--quiet-when-empty` prints nothing when there is
nothing waiting; `--server <url>` and `--token-file <path>` override the
defaults. It never exits 2, so an unreachable instance cannot stop a session
from starting.

`--check` exits non-zero when the connection is broken, so it works in a
monitoring script. Piping the key on stdin works too, for scripted installs:

```sh
printf '%s\n' "$KEY" | npx agentdash-connect --url https://your-instance
```

## If it does not work

| what you see | what it means |
|---|---|
| a help screen for some other tool, then exit 0 | you ran `npx` with the bare name `agentdash`; use the full `agentdash-connect` |
| the code is refused | it expired or was already used; create a new one |
| paired, but no "Inbox connected" line | a cached older CLI — rerun with `@latest` — or an instance older than v2026.914.0 |
| the host cannot be reached | a `.local` name over a VPN, usually; use the address you are browsing from |
| `403 Board access required` when you ask Claude to approve | it used the agent's key, which cannot decide approvals by design; the `agentdash-inbox` tools decide as you, and need 0.3.0 or later |
| no `agentdash-inbox` entry in `~/.claude.json` | connected before 0.3.0; re-run connect with a fresh code |

## Requirements

Node 18 or newer, and at least one of Claude Code or Codex already installed.
This wires up what is already on the machine; it does not install a harness for
you.

Zero runtime dependencies.
