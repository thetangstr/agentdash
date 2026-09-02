import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * AgentDash (AGE-12): nothing in the product may tell a person to run a CLI
 * that does not exist.
 *
 * The in-repo CLI's bin is `paperclipai`; the bare npm name `agentdash` is a
 * third party's package, so an instruction to run it through npx makes a
 * customer laptop download and execute a stranger's code that prints an
 * unrelated help screen and exits 0. That instruction was shipped once (the
 * bridge enrollment page) and repeated by a CoS to a customer. This test reads
 * every human- and agent-facing surface and refuses the two spellings.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const SCANNED_ROOTS = ["server/src", "ui/src", "cli/src", "packages", "doc", "docs", "README.md", "AGENTS.md"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "build"]);
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".md", ".mdx", ".json", ".mjs", ".txt"]);

const BOGUS_NPX = /npx\s+agentdash(?![\w-])/;
const BOGUS_BRIDGE_COMMAND = /(^|[^\w/.-])agentdash bridge run\b/;

function walk(root: string, out: string[]): void {
  const stat = statSync(root);
  if (stat.isFile()) {
    if (SCANNED_EXTENSIONS.has(path.extname(root))) out.push(root);
    return;
  }
  for (const entry of readdirSync(root)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    walk(path.join(root, entry), out);
  }
}

describe("bridge command name", () => {
  const cliPackage = JSON.parse(readFileSync(path.join(repoRoot, "cli", "package.json"), "utf8")) as {
    name: string;
    bin?: Record<string, string>;
  };
  const binNames = Object.keys(cliPackage.bin ?? {});

  it("the enrollment page prints the CLI package's real bin in front of `bridge run`", () => {
    const page = readFileSync(
      path.join(repoRoot, "ui", "src", "components", "agent", "ConnectYourMachine.tsx"),
      "utf8",
    );
    expect(binNames.length).toBeGreaterThan(0);
    const printed = page.match(/BRIDGE_CLI_BIN = "([^"]+)"/)?.[1];
    expect(printed, "ConnectYourMachine must pin BRIDGE_CLI_BIN").toBeDefined();
    expect(binNames).toContain(printed);
  });

  it("no surface tells anyone to run `npx agentdash` or `agentdash bridge run`", () => {
    const files: string[] = [];
    for (const root of SCANNED_ROOTS) {
      const absolute = path.join(repoRoot, root);
      try {
        statSync(absolute);
      } catch {
        continue;
      }
      walk(absolute, files);
    }
    expect(files.length).toBeGreaterThan(100);

    const self = fileURLToPath(import.meta.url);
    // The customer correction note quotes the wrong spelling on purpose: it
    // tells the steward exactly which command they ran and why it was wrong.
    const allowedQuotations = new Set([
      path.join(repoRoot, "doc", "customers", "mkthink", "07-bridge-command-correction.md"),
    ]);
    const offenders: string[] = [];
    for (const file of files) {
      if (file === self || allowedQuotations.has(file)) continue;
      const text = readFileSync(file, "utf8");
      if (BOGUS_NPX.test(text) || BOGUS_BRIDGE_COMMAND.test(text)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders, `surfaces still naming a CLI that does not exist:\n${offenders.join("\n")}`).toEqual([]);
  });
});
