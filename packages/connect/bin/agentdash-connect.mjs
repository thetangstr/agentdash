#!/usr/bin/env node
/**
 * npx agentdash-connect
 *
 * Asks for a link and a key, proves they work, then writes native MCP config
 * for whichever harnesses are installed. No daemon, no directories, nothing
 * left running. `--remove` reverses all of it.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";
import readline from "node:readline";

import {
  DEFAULT_SERVER_NAME,
  applyConnection,
  checkConnection,
  detectHarnesses,
  mcpEndpointFor,
  normalizeInstanceUrl,
  removeConnection,
  verifyConnection,
} from "../src/index.mjs";
import { VerifyError, redeemConnectCode } from "../src/verify.mjs";
import { formatConnectCode, looksLikeConnectCode } from "../src/codes.mjs";
import {
  defaultInboxDir,
  describeNotInstalled,
  ownerConflict,
  readBridgeOwner,
  resolveBridgeToken,
  resolveInboxServer,
  runInbox,
  scaffoldInboxWorkspace,
  storeBridgeOwner,
  storeBridgeToken,
} from "../src/inbox.mjs";
import { runInboxMcp } from "../src/inbox-mcp.mjs";
import { installWatch, runWatchCommand, uninstallWatch } from "../src/watch.mjs";
import {
  describeClientEntries,
  detectClaudeDesktop,
  removeInboxClients,
  setupInboxClients,
} from "../src/clients.mjs";
import { runCheck } from "../src/check.mjs";

// Read the real version rather than restating it. A CLI that misreports which
// version it is turns "did the fix reach me?" into guesswork -- which is
// exactly the question that matters right after a broken release.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/**
 * Hostname plus platform, so "what OS was that pairing?" is answerable from
 * the audit trail — it was asked, and nothing recorded had the answer.
 */
const deviceName = () => `${os.hostname()} (${process.platform})`;

const out = (line = "") => process.stdout.write(`${line}\n`);
const bad = (line = "") => process.stderr.write(`${line}\n`);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--remove") args.remove = true;
    else if (token === "--check") args.check = true;
    else if (token === "--version" || token === "-v") args.version = true;
    else if (token === "--url") args.url = argv[++i];
    else if (token === "--name") args.name = argv[++i];
    else if (token === "--server") args.server = argv[++i];
    else if (token === "--token-file") args.tokenFile = argv[++i];
    else if (token === "--client") args.client = argv[++i];
    else if (token === "--ack") args.ack = true;
    else if (token === "--quiet-when-empty") args.quietWhenEmpty = true;
    else if (token === "--read-only") args.readOnly = true;
    else if (token.startsWith("--server=")) args.server = token.slice(9);
    else if (token.startsWith("--token-file=")) args.tokenFile = token.slice(13);
    else if (token.startsWith("--client=")) args.client = token.slice(9);
    else if (token.startsWith("--url=")) args.url = token.slice(6);
    else if (token.startsWith("--name=")) args.name = token.slice(7);
    else args._.push(token);
  }
  return args;
}

function usage() {
  out(`agentdash-connect — connect this machine's coding agent to an AgentDash agent

  npx agentdash-connect KVTX-8F02        redeem a connect code
  npx agentdash-connect                  interactive: asks for the link and code
  npx agentdash-connect --url <url>      skip the URL question
  npx agentdash-connect check            which clients are connected, whose inbox
                                         this is, and whether review (bridge:work)
                                         is enabled (--check works too)
  npx agentdash-connect clients          add your inbox tools to Claude Code,
                                         Claude Desktop and Codex, using this
                                         machine's existing inbox connection
  npx agentdash-connect --remove         undo everything this wrote
  npx agentdash-connect inbox            read your AgentDash inbox (with --ack
                                         --quiet-when-empty it is the SessionStart
                                         hook in ~/agentdash-inbox: it speaks to
                                         Claude and keeps the review rules there
                                         up to date)
  npx agentdash-connect mcp              serve your own inbox tools (sync, decide,
                                         assign) to Claude Code, Claude Desktop
                                         or Codex over stdio
  npx agentdash-connect watch            macOS: a notification when an agent hands
                                         you work, and an optional read-only
                                         pre-review (watch --help for more)

Options
  --name <name>   MCP server name to write (default: ${DEFAULT_SERVER_NAME})
  --version       print the version
  --help          this

A connect code expires in ten minutes and works once, so it is safe to type on
a command line. An agent key is not: if you give one instead, it is read from
the terminal with echo off so it stays out of your shell history.`);
}

function ask(question, { silent = false } = {}) {
  // A piped stdin has nothing to echo and no tty to mute. Treating it like a
  // terminal waits forever for a keypress that is never coming, which breaks
  // every scripted or MDM-driven install -- precisely the ones with nobody
  // watching to notice it hung.
  if (!process.stdin.isTTY) {
    // Echo to stderr so a scripted run's log shows what was being asked for.
    // Silent prompts make a misfed pipe look like an unexplained failure.
    bad(question.trim());
    return new Promise((resolve) => {
      const piped = readline.createInterface({ input: process.stdin });
      // `close()` emits 'close' synchronously, so resolving there would beat
      // the answer we just read and hand the caller an empty string. Settle on
      // the value first; 'close' then only covers the genuine EOF-with-no-input
      // case, where resolving twice is a no-op anyway.
      piped.once("line", (answer) => {
        resolve(answer.trim());
        piped.close();
      });
      piped.once("close", () => resolve(""));
    });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (!silent) {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }
    // Hide typing without hiding the prompt: echo the prompt ourselves, then
    // mute the tty while the secret is entered.
    process.stdout.write(question);
    const onData = (char) => {
      const c = String(char);
      if (c === "\n" || c === "\r" || c === "") process.stdin.removeListener("data", onData);
    };
    process.stdin.on("data", onData);
    rl.output.write = () => true;
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

/**
 * The watcher is opt-in: asked on a terminal only, default no, and never
 * installed by a scripted run (which has nobody to answer). The pre-review is
 * a second, separate question.
 */
async function offerWatch(instanceUrl) {
  if (process.platform !== "darwin") return;
  if (!process.stdin.isTTY) {
    out("Mac notifications for new hand-offs are off. Turn them on any time: npx agentdash-connect watch --install");
    return;
  }
  out("");
  const watch = await ask(
    "Show a Mac notification when an agent hands you work? It checks your AgentDash every 15 minutes and talks to nothing else. [y/N]: ",
  );
  if (!/^y(es)?$/i.test(watch.trim())) {
    out("No notifications. Turn them on any time: npx agentdash-connect watch --install");
    return;
  }
  const pre = await ask(
    "Also let Claude Code prepare a first review of each hand-off in the background? Read-only, nothing is sent, and it uses your Claude usage. [y/N]: ",
  );
  try {
    const result = installWatch({ server: instanceUrl, preReview: /^y(es)?$/i.test(pre.trim()) });
    if (!result.config) {
      bad(`Notifications were not turned on: ${result.message}`);
      return;
    }
    out(`  watch   every ${result.config.intervalMinutes} minutes; pre-review ${result.config.preReview ? "on" : "off"}`);
    for (const file of result.written) out(`          ${file}`);
    if (result.message) bad(`  ${result.message}`);
    out("          turn it off with: npx agentdash-connect watch --uninstall");
  } catch (error) {
    bad(`Notifications were not turned on (${error?.message ?? error}). The connection above still works.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverName = args.name ?? DEFAULT_SERVER_NAME;
  const account = serverName;

  // `watch` has its own options (watch.mjs); hand it everything after the word.
  const argv = process.argv.slice(2);
  if (argv[0] === "watch") return runWatchCommand(argv.slice(1).filter((token) => token !== "--help" && token !== "-h"));

  if (args.help) return usage(), 0;
  if (args.version) return out(pkg.version), 0;

  if (args.remove) {
    const { removed: agentRemoved } = removeConnection({ serverName, account });
    const removed = [...agentRemoved, ...removeInboxClients({ serverName })];
    // The watcher is part of what connect set up, so it goes too.
    for (const file of uninstallWatch().removed) removed.push({ harness: "watch", file });
    if (removed.length === 0) {
      out(`Nothing to remove — no "${serverName}" connection was configured.`);
      return 0;
    }
    out(`Removed the "${serverName}" connection:`);
    for (const entry of removed) out(`  ${entry.harness.padEnd(7)} ${entry.file}`);
    out("");
    out("Open a new terminal so the removed environment variable stops being set.");
    return 0;
  }

  // The inbox read is what the scaffolded SessionStart hook runs, so it must
  // work with nothing but this package: token from ~/.agentdash/bridge-token,
  // server recovered from the MCP config the connect flow wrote.
  if (args._[0] === "inbox") {
    return runInbox({
      server: args.server,
      tokenFile: args.tokenFile,
      ack: Boolean(args.ack),
      quietWhenEmpty: Boolean(args.quietWhenEmpty),
    });
  }

  // Launched by Claude Code, not by a person: stdout is the protocol channel,
  // so nothing else may print to it.
  if (args._[0] === "mcp") {
    return runInboxMcp(
      { server: args.server, tokenFile: args.tokenFile, readOnly: Boolean(args.readOnly), client: args.client },
      { version: pkg.version },
    );
  }

  if (args.check || args._[0] === "check") {
    const found = detectHarnesses();
    return runCheck(
      { serverName, server: args.server },
      {
        installed: { claude: found.claude, codex: found.codex, desktop: detectClaudeDesktop().installed },
        checkAgent: () => checkConnection({ serverName, account }),
      },
    );
  }

  /*
   * Add the inbox tools to every client on this machine without a new
   * connect code: for someone who installed Claude Desktop or Codex after
   * connecting. Rides the inbox credential already stored here.
   */
  if (args._[0] === "clients") {
    const owner = readBridgeOwner();
    let instanceUrl = args.server ?? process.env.AGENTDASH_BRIDGE_SERVER ?? owner?.server ?? null;
    if (!instanceUrl) {
      try {
        instanceUrl = resolveInboxServer({});
      } catch {
        instanceUrl = null;
      }
    }
    try {
      resolveBridgeToken({ tokenFile: args.tokenFile });
    } catch (error) {
      bad(error.message);
      return 1;
    }
    if (!instanceUrl) {
      bad("No instance address found. Pass --server <url>.");
      return 1;
    }
    try {
      instanceUrl = normalizeInstanceUrl(instanceUrl);
    } catch (error) {
      bad(error.message);
      return 1;
    }
    const found = detectHarnesses();
    const desktop = detectClaudeDesktop().installed;
    if (!found.claude && !found.codex && !desktop) {
      bad("None of Claude Code, Claude Desktop or Codex was found on this machine.");
      return 1;
    }
    // The inbox folder too (hook, skill, AGENTS.md for Codex): idempotent,
    // and the only place Codex and Claude Code get the review rules.
    const inboxDir = defaultInboxDir();
    const scaffolded = scaffoldInboxWorkspace(inboxDir, { server: instanceUrl });
    const entries = setupInboxClients({
      serverName,
      instanceUrl,
      clients: { claude: found.claude, codex: found.codex, desktop },
    });
    out(`Your inbox tools (${instanceUrl}):`);
    for (const file of scaffolded.created) out(`  inbox   ${file}`);
    for (const file of scaffolded.updated) out(`  inbox   ${file} (updated to the packaged version)`);
    for (const line of describeNotInstalled(scaffolded.notInstalled)) out(`  inbox   ${line}`);
    let failed = false;
    for (const line of describeClientEntries(entries)) {
      if (line.problem) {
        failed = true;
        bad(line.text);
      } else out(line.text);
    }
    return failed ? 1 : 0;
  }

  const harnesses = detectHarnesses();
  const desktopFound = detectClaudeDesktop().installed;
  if (!harnesses.claude && !harnesses.codex && !desktopFound) {
    bad("None of Claude Code, Claude Desktop or Codex was found on this machine.");
    bad("Install one of them first — this command only wires up what is already here.");
    return 1;
  }

  out("Connecting this machine to an AgentDash agent.");
  out(
    `Found: ${[harnesses.claude && "Claude Code", desktopFound && "Claude Desktop", harnesses.codex && "Codex"].filter(Boolean).join(", ")}`,
  );
  out("");

  let instanceUrl = args.url ?? process.env.AGENTDASH_URL ?? "";
  if (!instanceUrl) instanceUrl = await ask("Instance link (e.g. http://mkmini.local:3103): ");
  try {
    instanceUrl = normalizeInstanceUrl(instanceUrl);
  } catch (error) {
    bad(error.message);
    return 1;
  }

  // A connect code is short-lived and single-use, so unlike an agent key it is
  // safe as an argument. Anything that is not code-shaped is treated as a key
  // and read from the terminal instead.
  const positional = args._[0];
  let key;
  let pairedWith = null;

  if (positional && looksLikeConnectCode(positional)) {
    out("");
    out(`Redeeming code ${formatConnectCode(positional)} …`);
    try {
      const paired = await redeemConnectCode(instanceUrl, positional, deviceName());
      key = paired.apiKey;
      pairedWith = paired;
    } catch (error) {
      bad("");
      bad(error instanceof VerifyError ? error.message : String(error?.message ?? error));
      if (error instanceof VerifyError && error.hint) bad(error.hint);
      bad("");
      bad("Nothing was written.");
      return 1;
    }
    out(
      `Paired as ${pairedWith.agentName}${pairedWith.companyName ? ` at ${pairedWith.companyName}` : ""}` +
        `, for this machine (${pairedWith.deviceName}).`,
    );
  } else {
    key = await ask("Agent key or connect code (input hidden): ", { silent: true });
    if (!key) {
      bad("Nothing given — nothing was changed.");
      return 1;
    }
    // Someone can paste a code at the key prompt; take it as one.
    if (looksLikeConnectCode(key)) {
      out("");
      out("That looks like a connect code — redeeming it.");
      try {
        const paired = await redeemConnectCode(instanceUrl, key, deviceName());
        key = paired.apiKey;
        pairedWith = paired;
        out(
          `Paired as ${paired.agentName}${paired.companyName ? ` at ${paired.companyName}` : ""}` +
            `, for this machine (${paired.deviceName}).`,
        );
      } catch (error) {
        bad("");
        bad(error instanceof VerifyError ? error.message : String(error?.message ?? error));
        if (error instanceof VerifyError && error.hint) bad(error.hint);
        bad("");
        bad("Nothing was written.");
        return 1;
      }
    }
  }

  const endpoint = mcpEndpointFor(instanceUrl);
  out("");
  out(`Checking ${endpoint} …`);
  let verified;
  try {
    verified = await verifyConnection(endpoint, key);
  } catch (error) {
    bad("");
    bad(error instanceof VerifyError ? error.message : String(error?.message ?? error));
    if (error instanceof VerifyError && error.hint) bad(error.hint);
    bad("");
    bad("Nothing was written.");
    return 1;
  }

  out(`Connected. ${verified.toolCount} tools available${verified.hasInstructions ? ", agent briefing received" : ""}.`);
  out("");

  const { envVar, written, secretBackend } = applyConnection({
    serverName,
    instanceUrl,
    key,
    harnesses,
    account,
  });

  out("Wrote:");
  for (const entry of written) out(`  ${entry.harness.padEnd(7)} ${entry.file}\n          ${entry.note}`);
  out("");
  if (harnesses.codex && secretBackend === "file") {
    out(`Note: no OS keychain was available, so the key is in ~/.agentdash/${account}.key (mode 600).`);
  }
  /*
   * The other half of the connection: the inbox. Redeeming a code now also
   * mints a bridge endpoint for whoever created the code — that credential is
   * how the agent's questions reach this person, and it is deliberately not
   * the agent key written above (the inbox is the steward's own; an agent's
   * credential must never read it). An older instance returns no bridgeToken,
   * and this block simply does not run — pairing still works as before.
   */
  if (pairedWith?.bridgeToken) {
    try {
      /**
       * Never silently replace a different person's inbox connection. The
       * failure this guards actually happened: a shared machine, re-paired
       * under another signed-in account, switched whose approvals arrived
       * here with nothing on screen saying so. Replacing is allowed — one
       * machine changing hands is normal — but only as an answered question.
       */
      const conflict = ownerConflict(readBridgeOwner(), pairedWith.owner ?? null);
      if (conflict) {
        bad("");
        bad(`This machine's inbox currently belongs to ${conflict.existing}.`);
        bad(`This pairing would hand it to ${conflict.incoming} instead.`);
        const answer = await ask(`Replace it? [y/N]: `);
        if (!/^y(es)?$/i.test(answer.trim())) {
          out("Kept the existing inbox connection. The agent pairing above still stands.");
          throw { skipped: true };
        }
      }
      const tokenPath = storeBridgeToken(pairedWith.bridgeToken);
      if (pairedWith.owner) storeBridgeOwner(pairedWith.owner, { server: instanceUrl });
      const inboxDir = defaultInboxDir();
      const { created, updated, notInstalled } = scaffoldInboxWorkspace(inboxDir, { server: instanceUrl });
      out("");
      const ownerLine = pairedWith.owner?.name
        ? `${pairedWith.owner.name}${pairedWith.owner.email ? ` (${pairedWith.owner.email})` : ""}`
        : null;
      out(ownerLine ? `Inbox connected for ${ownerLine}:` : "Inbox connected too:");
      out(`  token   ${tokenPath}
          your inbox credential (mode 600) — questions for you arrive with it`);
      for (const file of created) out(`  inbox   ${file}`);
      for (const file of updated) out(`  inbox   ${file} (updated to the packaged version)`);
      for (const line of describeNotInstalled(notInstalled)) out(`  inbox   ${line}`);
      // The person's own inbox tools in every client here: Claude Code,
      // Claude Desktop (merged into its config, backed up first) and Codex.
      const entries = setupInboxClients({
        serverName,
        instanceUrl,
        clients: { claude: harnesses.claude, codex: harnesses.codex, desktop: desktopFound },
      });
      for (const line of describeClientEntries(entries)) (line.problem ? bad : out)(line.text);
      out("");
      if (harnesses.claude) {
        out(`Open ${inboxDir} in Claude Code: anything waiting on you appears as the session starts, and Claude reviews it with you.`);
      }
      if (harnesses.codex) {
        out(`In Codex, start sessions in ${inboxDir}: its AGENTS.md tells Codex to review what is waiting first.`);
      }
      out("Check the connection any time with:  npx agentdash-connect check");
      await offerWatch(instanceUrl);
    } catch (error) {
      if (!error?.skipped) {
        // The agent pairing above already succeeded; say what did not, precisely.
        bad(`Inbox setup failed (${error?.message ?? error}). The agent connection above still works.`);
        bad(`Retry later with a fresh connect code.`);
      }
    }
  }

  out(`Start a new session and ask your agent to list its AgentDash tools.`);
  out(`Undo any time with:  npx agentdash-connect --remove${args.name ? ` --name ${serverName}` : ""}`);
  if (harnesses.codex) out(`Codex needs a new terminal so ${envVar} is set.`);
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    bad(`agentdash-connect failed: ${error?.message ?? error}`);
    process.exit(1);
  });
