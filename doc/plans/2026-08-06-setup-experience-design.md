# Setup experience — designing against Multica

**Date:** 2026-08-06
**Status:** proposal, for review.

## What Multica does

```
brew install multica-ai/tap/multica          # or curl | bash, or irm | iex on Windows
multica setup                                 # or: multica setup self-host
```

Then three beats in the browser: **your machine appears under Settings → Runtimes**, you
create an agent by picking a runtime and a provider, you file an issue and it runs.

Four properties do the work:

1. **One verb.** `setup` covers config, auth, and starting the daemon.
2. **No keys pasted.** Authentication happens in the browser; you are never asked for an
   API key or an environment variable during setup.
3. **Auto-detection.** The daemon finds agent CLIs already on your `PATH` — you don't tell
   it that Claude Code is installed, it notices.
4. **One confirmation moment.** "Your machine appeared in the list" is a beat you can see,
   before you have done anything real.

## The uncomfortable finding

We already have most of this, and our documentation routes around it.

| Multica | AgentDash today | Where |
|---|---|---|
| `brew install` / `curl \| bash` | `curl \| bash` exists | `scripts/bootstrap-fresh-mac.sh` |
| `multica setup` | **`agentdash setup` exists** — a real `@clack/prompts` wizard | `cli/src/commands/setup.ts` |
| daemon start folded in | **`agentdash run`** = onboard-if-needed → doctor with repair → start | `cli/src/commands/run.ts` |
| browser auth, no email | **one-time password link**, no email provider needed | MCP signup `passwordSetupUrl` |
| no database step | **embedded Postgres** — nothing to install at all | `server/src/index.ts` |
| verify the provider works | **live "say hello" test** against the chosen model | `setup.ts:269` |

The wizard even asks the question Multica doesn't: *"Run a quick test prompt against
{provider}? (~30s; calls the model with 'say hello' to verify auth + network)"* — that is a
better confidence beat than anything in their flow, and today almost nobody sees it.

**Meanwhile the path we actually hand customers** — `doc/customers/mkthink/codex-install-prompt.md`
and my own `doc/GETTING-STARTED.md` — has the operator hand-write a twenty-line env file,
generate two secrets with `openssl`, paste a licence key and a licence public key, and paste
two different invite codes. We built the elegant thing and then documented the manual one.

## The four real gaps

Stripping out what we already have, this is what is genuinely missing:

### 1. Four values still have to be pasted
Licence key, licence public key, signup invite code, workspace code. Multica asks for none.
This is the largest elegance gap and it is self-inflicted.

**Fix:** collapse four into **one**. Issue a single `AGENTDASH_ACTIVATION_CODE` that the
setup wizard exchanges over HTTPS for everything else — licence, public key, and profile
entitlement. The operator types one code once, the way they type a Wi-Fi password.
Air-gapped installs keep the manual path as a documented fallback.

### 2. We ask which provider; Multica notices
The wizard prompts for an adapter. It should first scan `PATH` for `claude`, `codex`,
`cursor`, `opencode`, `gemini` and present what it found — "Found Claude Code. Use it? (Y/n)" —
falling back to the full list when nothing is detected. The adapter registry already knows
these names; nothing new is needed except the scan.

### 3. There is no "your machine appeared" moment
Multica's step 2 is pure reassurance and it is cheap. We have the ingredients: adapters,
environments, and the bridge endpoints a person enrols. What is missing is a **Runtimes**
view that says *this Mac mini, Claude Code detected, last seen 4 seconds ago*. That single
screen is what converts "I ran a command" into "it is working."

### 4. Too many verbs
`setup`, `onboard`, `run`, `doctor`, plus `paperclipai run`. A newcomer cannot tell which
one to type. **`agentdash setup` should be the only documented verb**, doing what
`run` does today: onboard if needed, repair, start, print the URL. The others stay as
subcommands for people who want them.

## What I would ship

```
curl -fsSL https://get.agentdash.com | bash     # installs the CLI
agentdash setup                                  # everything else
```

and the wizard, in order:

1. **Prerequisites** — check and offer to install what is missing.
2. **Activation code** — one paste. Exchanges for licence + entitlement.
3. **Where should this be reachable?** — loopback / LAN / Tailscale. *(Already built.)*
4. **Providers** — "Found Claude Code and Codex on this machine." Pick one; offer the live
   hello test. *(Test already built; detection is new.)*
5. **Start** — boot, run doctor with repair, install the login service, hold the machine awake.
6. **Print one URL and one claim link.** Nothing else.

Then in the browser: your machine under **Runtimes**, your first agent, your first task.

Everything above except the activation-code exchange, the PATH scan, and the Runtimes view
already exists. The work is mostly deletion and re-pointing the docs, not new capability.

## Coverage: the cases Multica does not have

Elegance is not the only axis. Our flow has to cover things theirs does not, and the design
above must not lose them:

| Case | Handled by |
|---|---|
| A workspace with the workforce features vs an ordinary one | the activation code carries the entitlement, instead of a second invite code |
| Multiple humans, each with their own agent | invite links printed at the end of setup; pairing after they accept |
| Per-person agent keys for their own desktop harness | shown on each person's **My Agent** page |
| An on-prem licence that expires | surfaced in the owner's billing/entitlement view — see the subscription proposal |
| Air-gapped or no outbound network | manual env path stays documented, with `AGENTDASH_INVITE_VALIDATION=off` |

## Open questions

- Is an activation-code exchange service something we want to run? It is the piece that
  makes the flow feel like Multica's, and it is also a new dependency in the install path
  that fails closed if it is unreachable.
- Do we want `brew` (a tap is cheap and is what people expect on a Mac), or is `curl | bash`
  enough for design partners?
- Should **Runtimes** be a new view, or a section of the existing Company Settings? A new
  top-level view is more discoverable and matches how people think about "my machines."
