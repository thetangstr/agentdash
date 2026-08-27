import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writePackage(root, directory, pkg) {
  const packageDir = path.join(root, directory);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function createFixture({ includeOwnedPackage = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "agentdash-release-package-map-"));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  copyFileSync(
    path.join(repoRoot, "scripts/release-package-map.mjs"),
    path.join(root, "scripts/release-package-map.mjs"),
  );

  if (includeOwnedPackage) {
    writePackage(root, "packages/connect", {
      name: "agentdash-connect",
      version: "0.1.4",
    });
  }

  writePackage(root, "packages/inherited", {
    name: "@paperclipai/inherited",
    version: "9.9.9",
  });
  writePackage(root, "packages/unprovisioned", {
    name: "@agentdash/unprovisioned",
    version: "9.9.9",
  });

  mkdirSync(path.join(root, "cli/src"), { recursive: true });
  writeFileSync(path.join(root, "cli/src/index.ts"), 'program.version("0.0.0");\n');
  return root;
}

function runPackageMap(root, ...args) {
  return execFileSync("node", [path.join(root, "scripts/release-package-map.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("lists only explicitly owned AgentDash release packages", () => {
  const root = createFixture();
  try {
    assert.equal(runPackageMap(root, "list"), "packages/connect\tagentdash-connect\t0.1.4\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version rewrites cannot modify inherited or unprovisioned packages", () => {
  const root = createFixture();
  try {
    runPackageMap(root, "set-version", "0.1.5");

    const owned = JSON.parse(readFileSync(path.join(root, "packages/connect/package.json"), "utf8"));
    const inherited = JSON.parse(
      readFileSync(path.join(root, "packages/inherited/package.json"), "utf8"),
    );
    const unprovisioned = JSON.parse(
      readFileSync(path.join(root, "packages/unprovisioned/package.json"), "utf8"),
    );

    assert.equal(owned.version, "0.1.5");
    assert.equal(inherited.version, "9.9.9");
    assert.equal(unprovisioned.version, "9.9.9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when an allowlisted package is missing", () => {
  const root = createFixture({ includeOwnedPackage: false });
  try {
    assert.throws(
      () => runPackageMap(root, "list"),
      /owned release package packages\/connect \(agentdash-connect\) is missing/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
