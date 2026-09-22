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
  applyInboxMcp,
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
  ownerConflict,
  readBridgeOwner,
  runInbox,
  scaffoldInboxWorkspace,
  storeBridgeOwner,
  storeBridgeToken,
} from "../src/inbox.mjs";
import { runInboxMcp } from "../src/inbox-mcp.mjs";
import { renderConnectSummary } from "../src/summary.mjs";

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
    else if (token === "--ack") args.ack = true;
    else if (token === "--quiet-when-empty") args.quietWhenEmpty = true;
    else if (token.startsWith("--server=")) args.server = token.slice(9);
    else if (token.startsWith("--token-file=")) args.tokenFile = token.slice(13);
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
  npx agentdash-connect --check          is the existing connection still good?
  npx agentdash-connect --remove         undo everything this wrote
  npx agentdash-connect inbox            read your AgentDash inbox (used by the
                                         SessionStart hook in ~/agentdash-inbox)
  npx agentdash-connect mcp              serve your own inbox tools (sync, decide,
                                         assign) to Claude Code over stdio

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverName = args.name ?? DEFAULT_SERVER_NAME;
  const account = serverName;

  if (args.help) return usage(), 0;
  if (args.version) return out(pkg.version), 0;

  if (args.remove) {
    const { removed } = removeConnection({ serverName, account });
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
    return runInboxMcp({ server: args.server, tokenFile: args.tokenFile }, { version: pkg.version });
  }

  if (args.check) {
    const status = await checkConnection({ serverName, account });
    if (!status.configured) {
      bad(`No "${serverName}" connection is configured on this machine.`);
      return 1;
    }
    out(`Endpoint  ${status.endpoint}`);
    out(`Claude    ${status.claudeServer ? "configured" : "not configured"}`);
    out(`Codex     ${status.codexServer ? `configured (reads ${status.codexServer.envVar})` : "not configured"}`);
    if (status.verified) {
      out(`Status    working — ${status.verified.toolCount} tools available`);
      return 0;
    }
    bad(`Status    NOT working — ${status.reason ?? "unknown reason"}`);
    return 1;
  }

  const harnesses = detectHarnesses();
  if (!harnesses.claude && !harnesses.codex) {
    bad("Neither Claude Code nor Codex was found on this machine.");
    bad("Install one of them first — this command only wires up what is already here.");
    return 1;
  }

  out("Connecting this machine to an AgentDash agent.");
  out(`Found: ${[harnesses.claude && "Claude Code", harnesses.codex && "Codex"].filter(Boolean).join(", ")}`);
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

  const { envVar, written, secretBackend } = applyConnection({
    serverName,
    instanceUrl,
    key,
    harnesses,
    account,
  });

  const agentName = pairedWith?.agentName ?? `your agent (${verified.toolCount} tools)`;
  const files = [];
  for (const entry of written) {
    if (entry.harness === "claude") files.push({ file: entry.file, what: `${agentName}'s agent key ("${serverName}")` });
    else if (entry.file.endsWith("config.toml")) files.push({ file: entry.file, what: `Codex config, reads ${envVar}` });
    else files.push({ file: entry.file, what: `one line exporting ${envVar} for Codex` });
  }
  if (harnesses.codex) {
    files.push(
      secretBackend === "file"
        ? { file: `~/.agentdash/${account}.key`, what: "Codex key (no OS keychain was available)" }
        : { file: "OS keychain", what: "Codex key" },
    );
  }

  /*
   * The other half of the connection: the inbox. Redeeming a code now also
   * mints a bridge endpoint for whoever created the code — that credential is
   * how the agent's questions reach this person, and it is deliberately not
   * the agent key written above (the inbox is the steward's own; an agent's
   * credential must never read it). An older instance returns no bridgeToken,
   * and this block simply does not run — pairing still works as before.
   */
  let inbox = "unsupported";
  let keptOwner = null;
  let inboxError = null;
  if (pairedWith?.bridgeToken) {
    try {
      /**
       * Never silently replace a different person's inbox connection. The
       * failure this guards actually happened: a shared machine, re-paired
       * under another signed-in account, switched whose approvals arrived
       * here with nothing on screen saying so. Replacing is allowed — one
       * machine changing hands is normal — but only as an answered question,
       * and with no terminal attached (Claude running this for someone) there
       * is nobody to answer it, so the existing inbox is kept and the summary
       * says how to replace it.
       */
      const conflict = ownerConflict(readBridgeOwner(), pairedWith.owner ?? null);
      if (conflict) {
        keptOwner = conflict.existing;
        let replace = false;
        if (process.stdin.isTTY) {
          bad("");
          bad(`This machine's inbox currently belongs to ${conflict.existing}.`);
          bad(`This pairing would hand it to ${conflict.incoming} instead.`);
          replace = /^y(es)?$/i.test((await ask(`Replace it? [y/N]: `)).trim());
        }
        if (!replace) throw { skipped: true };
      }
      const tokenPath = storeBridgeToken(pairedWith.bridgeToken);
      files.push({ file: tokenPath, what: "your inbox credential" });
      if (pairedWith.owner) {
        files.push({ file: storeBridgeOwner(pairedWith.owner, { server: instanceUrl }), what: "whose inbox this is" });
      }
      if (harnesses.claude) {
        const inboxMcp = applyInboxMcp({ serverName, instanceUrl });
        const claudeLine = files.find((entry) => entry.file === inboxMcp.file);
        if (claudeLine) claudeLine.what += `, and your inbox tools ("${inboxMcp.name}")`;
        else files.push({ file: inboxMcp.file, what: `your inbox tools ("${inboxMcp.name}")` });
      }
      // Optional, not a step: the inbox tools above work in every session.
      // Starting Claude Code in this folder also shows the inbox as it opens.
      const inboxDir = defaultInboxDir();
      scaffoldInboxWorkspace(inboxDir, { server: instanceUrl });
      files.push({ file: `${inboxDir}/`, what: "optional: start Claude Code here to see your inbox as it opens" });
      inbox = "connected";
    } catch (error) {
      if (error?.skipped) {
        inbox = "kept";
      } else {
        inbox = "failed";
        inboxError = error?.message ?? String(error);
      }
    }
  }

  out("");
  out(
    renderConnectSummary({
      agentName,
      companyName: pairedWith?.companyName ?? null,
      harnesses,
      inbox,
      owner: pairedWith?.owner ?? null,
      keptOwner,
      inboxError,
      files,
      codexEnvVar: harnesses.codex ? envVar : null,
      undo: `npx agentdash-connect --remove${args.name ? ` --name ${serverName}` : ""}`,
    }),
  );
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    bad(`agentdash-connect failed: ${error?.message ?? error}`);
    process.exit(1);
  });
