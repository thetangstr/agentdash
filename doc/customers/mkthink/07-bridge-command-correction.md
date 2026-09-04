# Bridge command correction — note for the steward

*Prepared for the founder to send. Nothing in this note requires action on the AgentDash server.*

---

Hi —

One correction to the "connect your machine" step you ran earlier, and an apology for the confusion it caused.

**What happened.** The enrollment page told you to run `agentdash bridge run …`, and the CoS gave a colleague `npx agentdash --help` as a reconnect step. Neither of those commands is ours. There is no installed program called `agentdash`, and the package published under that bare name on the public npm registry belongs to an unrelated third party. So `npx agentdash …` downloaded that third-party package, printed its own help screen, and exited without error — which looked like success and was not.

**What that means for the laptop it ran on.** The package that ran is a small, unrelated CLI; running it once through `npx` does not install anything persistent, does not change your AgentDash setup, and does not touch your bridge token. If you would like to be thorough, clear the npx cache with `npx clear-npx-cache` (or delete `~/.npm/_npx`) and you are back to a clean state. Please do not run the bare `agentdash` name again.

**The corrected steps.** The real command is `paperclipai bridge run`. `paperclipai` is the AgentDash command-line tool that ships with the AgentDash server itself (macOS only; it needs Node 20 or newer). It is installed from the same release the server runs — your administrator has it; there is no separate download and nothing to fetch from npm.

1. Save your bridge token exactly as the enrollment page shows (it writes `~/.agentdash/bridge-token` with owner-only permissions).
2. Choose how much of the network the sandbox may reach. There is no default and the tool will
   not start without this — it is a decision we are not making for you.

   - `--egress loopback` — localhost only. Stronger, but reaching the Anthropic API then needs an
     allowlisting proxy running on your machine; without one, every question fails.
   - `--egress direct` — allows outbound 443, so the sandbox reaches the Anthropic API directly
     with nothing inspecting that traffic. Weaker, and needs no extra setup.

3. Leave this running in a terminal, with a real Anthropic API key in place of the placeholder:

   ```sh
   export ANTHROPIC_API_KEY=sk-ant-...
   paperclipai bridge run \
     --server <your AgentDash URL> \
     --token-file ~/.agentdash/bridge-token \
     --egress direct
   ```

   The key is not optional. The sandbox denies your home directory, so the tool cannot read a
   desktop `claude` login; without a key in the environment it connects normally and then fails
   every question it picks up.

4. To keep the bridge open across sign-ins, wrap that command in a login item or a `launchd` agent. When it stops, the enrollment page shows your machine as "last seen" at the moment it went quiet, so you can tell "enrolled but never polled" from "connected".

**A second correction.** The command in our earlier note was still not runnable: it was missing
`--egress`, which the tool requires and deliberately will not default, so it exited immediately with
`Refusing to start: --egress is required and has no default.` The steps above are the corrected
version, and we have verified them against a running instance rather than by reading the code. The
enrollment page now asks for the posture and prints the full command, and a test refuses any command
that omits an option the tool requires.

Thanks for catching it, and again, sorry for the detour.
