#!/usr/bin/env node
/**
 * npx agentdash-connect
 *
 * Asks for a link and a key, proves they work, then writes native MCP config
 * for whichever harnesses are installed. No daemon, no directories, nothing
 * left running. `--remove` reverses all of it.
 */

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
  if (args.version) return out("0.1.0"), 0;

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
    out("");
    out(`Redeeming code ${formatConnectCode(positional)} …`);
    try {
      const paired = await redeemConnectCode(instanceUrl, positional, os.hostname());
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
        const paired = await redeemConnectCode(instanceUrl, key, os.hostname());
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
