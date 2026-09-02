# Bridge command correction — note for the steward

*Prepared for the founder to send. Nothing in this note requires action on the AgentDash server.*

---

Hi —

One correction to the "connect your machine" step you ran earlier, and an apology for the confusion it caused.

**What happened.** The enrollment page told you to run `agentdash bridge run …`, and the CoS gave a colleague `npx agentdash --help` as a reconnect step. Neither of those commands is ours. There is no installed program called `agentdash`, and the package published under that bare name on the public npm registry belongs to an unrelated third party. So `npx agentdash …` downloaded that third-party package, printed its own help screen, and exited without error — which looked like success and was not.

**What that means for the laptop it ran on.** The package that ran is a small, unrelated CLI; running it once through `npx` does not install anything persistent, does not change your AgentDash setup, and does not touch your bridge token. If you would like to be thorough, clear the npx cache with `npx clear-npx-cache` (or delete `~/.npm/_npx`) and you are back to a clean state. Please do not run the bare `agentdash` name again.

**The corrected steps.** The real command is `paperclipai bridge run`. `paperclipai` is the AgentDash command-line tool that ships with the AgentDash server itself (macOS only; it needs Node 20 or newer). It is installed from the same release the server runs — your administrator has it; there is no separate download and nothing to fetch from npm.

1. Save your bridge token exactly as the enrollment page shows (it writes `~/.agentdash/bridge-token` with owner-only permissions).
2. Leave this running in a terminal:

   ```sh
   paperclipai bridge run \
     --server <your AgentDash URL> \
     --token-file ~/.agentdash/bridge-token
   ```

3. To keep the bridge open across sign-ins, wrap that command in a login item or a `launchd` agent. When it stops, the enrollment page shows your machine as "last seen" at the moment it went quiet, so you can tell "enrolled but never polled" from "connected".

The enrollment page now prints the corrected command and explains where the tool comes from. The previous instruction has been removed from every page and from the agents' own guidance, and a test in the codebase now refuses either wrong spelling.

Thanks for catching it, and again, sorry for the detour.
