import os from "node:os";

/**
 * What a person reads when connecting is done. Outcome first, then the one
 * next step, then the files — in that order because the first two are what
 * most people act on and the last is what an IT reviewer checks.
 *
 * A pure function so the exact words are testable. Before this the success
 * path was a dozen `out()` calls interleaved with the work, the inbox half
 * printed "open ~/agentdash-inbox" as if it were a required step, and nothing
 * pinned any of it.
 */

export const NEXT_QUESTION = "What's waiting on me in AgentDash?";

/** `/Users/titus/.claude.json` → `~/.claude.json`, so the list reads the same on every machine. */
export function tildePath(file, home = os.homedir()) {
  if (!file || !home) return file;
  return file === home ? "~" : file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

function who(owner) {
  if (!owner?.name && !owner?.email) return null;
  return owner.name && owner.email ? `${owner.name}, ${owner.email}` : owner.name || owner.email;
}

/**
 * @param {object} input
 * @param {string} input.agentName
 * @param {string|null} [input.companyName]
 * @param {{claude?: boolean, codex?: boolean}} input.harnesses
 * @param {"connected"|"kept"|"failed"|"unsupported"} input.inbox
 * @param {{name?: string|null, email?: string|null}|null} [input.owner]  whose inbox this is now
 * @param {string|null} [input.keptOwner]  for "kept": who the inbox still belongs to
 * @param {string|null} [input.inboxError]  for "failed"
 * @param {Array<{file: string, what: string}>} input.files
 * @param {string|null} [input.codexEnvVar]
 * @param {string} input.undo
 * @param {string} [input.home]
 */
export function renderConnectSummary(input) {
  const {
    agentName,
    companyName = null,
    harnesses,
    inbox,
    owner = null,
    keptOwner = null,
    inboxError = null,
    files,
    codexEnvVar = null,
    undo,
    home,
  } = input;

  const where = [harnesses.claude && "Claude Code", harnesses.codex && "Codex"].filter(Boolean).join(" and ");
  const agent = `${agentName}${companyName ? ` at ${companyName}` : ""}`;
  const lines = [];

  if (inbox === "connected") {
    const person = who(owner);
    lines.push(`Connected. ${agent} is ready in ${where}, and so is your inbox${person ? ` (${person})` : ""}.`);
  } else if (inbox === "kept") {
    lines.push(`Connected. ${agent} is ready in ${where}.`);
    lines.push(
      `Your inbox was not changed: this machine's inbox belongs to ${keptOwner ?? "someone else"}.` +
        ` To replace it, run the same command in a terminal and answer yes.`,
    );
  } else if (inbox === "failed") {
    lines.push(`Connected. ${agent} is ready in ${where}, but inbox setup failed (${inboxError ?? "unknown error"}).`);
    lines.push("Create a fresh code on your My Agent page and run it again to add the inbox.");
  } else {
    lines.push(`Connected. ${agent} is ready in ${where}.`);
    lines.push("This AgentDash instance does not offer an inbox yet, so only the agent was connected.");
  }

  lines.push("");
  if (harnesses.claude) {
    lines.push("Next: restart Claude Code — new tools load only when a session starts — then ask:");
    lines.push(`  ${NEXT_QUESTION}`);
    if (inbox === "connected") lines.push("You can approve or reject right there in the chat.");
  }
  if (harnesses.codex && codexEnvVar) {
    lines.push(`Codex: open a new terminal first, so ${codexEnvVar} is set.`);
  }

  lines.push("");
  lines.push("Written (credentials at mode 600):");
  const shown = files.map((entry) => ({ file: tildePath(entry.file, home), what: entry.what }));
  const width = Math.min(34, Math.max(...shown.map((entry) => entry.file.length)));
  for (const entry of shown) lines.push(`  ${entry.file.padEnd(width)}  ${entry.what}`);
  lines.push(`Undo: ${undo}`);

  return lines.join("\n");
}
