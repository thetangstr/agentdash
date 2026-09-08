import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSetupLine, CONNECT_CLI_BIN, INBOX_DIR } from "./ConnectInClaudeOrCodex";

const KEY = "bt_example_key_value";
const ORIGIN = "http://mkmini.local:3102";

describe("buildSetupLine", () => {
  /**
   * The defect this exists for, and it made the documented flow unusable.
   *
   * The old card printed `bridge inbox-init <dir> --server <origin>` with no
   * `--token-file`. `scaffoldInboxWorkspace` bakes that flag into the hook it
   * installs only when the flag is given, and `resolveToken` has no default
   * path — with neither, it demands `AGENTDASH_BRIDGE_TOKEN` from the
   * environment and otherwise throws, which the inbox command turns into a
   * quiet exit 1. So the token file the user had just been told to create was
   * never read, and an environment variable nobody documented was required.
   * Following the on-screen steps exactly produced a connection that could not
   * authenticate.
   */
  it("hands the token path to inbox-init, or the hook cannot authenticate", () => {
    const line = buildSetupLine(KEY, ORIGIN);
    expect(line).toContain("--token-file ~/.agentdash/bridge-token");
    // and the file it names is the one it just wrote
    const written = line.slice(0, line.indexOf("--token-file"));
    expect(written).toContain("> ~/.agentdash/bridge-token");
  });

  it("is one pasted line, not a sequence of steps", () => {
    const line = buildSetupLine(KEY, ORIGIN);
    expect(line).not.toContain("\n");
    // Chained so a failure stops instead of half-building the setup.
    expect(line.split(" && ").length).toBeGreaterThanOrEqual(4);
  });

  it("carries the key and the instance address so nothing else must be typed", () => {
    const line = buildSetupLine(KEY, ORIGIN);
    expect(line).toContain(KEY);
    expect(line).toContain(`--server ${ORIGIN}`);
    expect(line).toContain(INBOX_DIR);
  });

  /** Keeps the key out of a world-readable file. */
  it("restricts the key file it writes", () => {
    expect(buildSetupLine(KEY, ORIGIN)).toContain("chmod 600 ~/.agentdash/bridge-token");
  });

  /**
   * `agentdash` is on PATH too, but an unrelated package owns that name on npm
   * and a steward already reached a stranger's package that way. This prints
   * the bin the package actually declares.
   */
  it("names the program the package declares", () => {
    expect(CONNECT_CLI_BIN).toBe("paperclipai");
    expect(buildSetupLine(KEY, ORIGIN)).toContain("paperclipai bridge inbox-init");
    expect(buildSetupLine(KEY, ORIGIN)).not.toContain("npx agentdash");
  });

  /** No API key anywhere in the flow — that belonged to the withdrawn worker. */
  it("asks for no Anthropic credential", () => {
    expect(buildSetupLine(KEY, ORIGIN)).not.toMatch(/ANTHROPIC|sk-ant/i);
  });
});

describe("guidance copy", () => {
  const source = readFileSync(
    new URL("./ConnectInClaudeOrCodex.tsx", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

  /** The three contradictions the owner identified in the previous guide. */
  it("does not promise no duplicates when open approvals repeat", () => {
    expect(source).toMatch(/mentioned again each time you look/i);
  });

  it("says the automatic on-open check is Claude Code only, not general", () => {
    expect(source).toMatch(/on-open check is a Claude Code feature and does not apply/i);
  });

  it("keeps Codex CLI, the ChatGPT app and ChatGPT web apart", () => {
    expect(source).toMatch(/Codex on the command line has no scheduling/i);
    expect(source).toMatch(/inside<\/span> a chat reports back to that chat|inside.{0,40}a chat reports back/i);
    expect(source).toMatch(/ChatGPT on the web cannot reach anything on your own machine/i);
  });

  it("does not claim the conversation can approve yet", () => {
    expect(source).toMatch(/needs an add-on this instance does not publish yet/i);
  });

  it("promises no AgentDash timer", () => {
    expect(source).toMatch(/never runs a timer of its own/i);
  });
});
