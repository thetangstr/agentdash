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

/**
 * AgentDash: one canonical user-facing command.
 *
 * The repo ships two names for the same CLI: `paperclipai`, which is the bin
 * `cli/package.json` declares, and `agentdash`, which is what the in-repo
 * wrapper is called. Both are installed, and that is fine — what is not fine is
 * teaching both, because only one of them is safe to teach.
 *
 * `agentdash` on the public npm registry belongs to an unrelated third party.
 * Somebody without our wrapper who follows an instruction to run it reaches a
 * stranger's package, which prints a help screen and exits 0 — indistinguishable
 * from success. That happened to a steward. So the canonical name is the
 * packaged bin, and the alias is never the name we print.
 */
describe("canonical CLI command name", () => {
  const cliPackage = JSON.parse(readFileSync(path.join(repoRoot, "cli", "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  const canonical = Object.keys(cliPackage.bin ?? {})[0];
  const installer = readFileSync(path.join(repoRoot, "scripts", "install-cli.sh"), "utf8");

  it("is the bin the CLI package declares", () => {
    expect(canonical).toBe("paperclipai");
  });

  it("is what the installer puts on PATH, alongside the alias", () => {
    expect(installer).toContain(`create_symlink "${canonical}"`);
    expect(installer).toContain('create_symlink "agentdash"');
  });

  it("is the name the installer tells a person to type", () => {
    const told = installer.match(/Try \\?`([a-z-]+) --help/);
    expect(told?.[1], "the installer's closing line must name the canonical command").toBe(
      canonical,
    );
    expect(installer, "user-facing messages must not be prefixed with the alias").not.toMatch(
      /echo "agentdash: /,
    );
  });

  /**
   * `"$VAR…"` swallows the variable: bash reads the multibyte ellipsis as part
   * of the identifier, so the message prints without the value. Both shell
   * scripts that did this said "installing into " and then nothing.
   */
  it("never interpolates a bare variable straight into a multibyte character", () => {
    // Its own walk: the shared `walk` filters by SCANNED_EXTENSIONS, which
    // does not include .sh, so reusing it would make this assertion vacuous.
    const shellScripts: string[] = [];
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (SKIPPED_DIRS.has(entry)) continue;
        const absolute = path.join(dir, entry);
        if (statSync(absolute).isDirectory()) collect(absolute);
        else if (entry.endsWith(".sh")) shellScripts.push(absolute);
      }
    };
    collect(path.join(repoRoot, "scripts"));
    expect(shellScripts.length, "expected to find shell scripts to scan").toBeGreaterThan(3);

    const offenders = shellScripts
      .filter((file) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(repoRoot, file));
    expect(offenders, "brace these as ${VAR} or the value is silently dropped").toEqual([]);
  });
});
