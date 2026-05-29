#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateLaunchSignoffPolicy } from "./check-launch-signoff.mjs";

test("current repository satisfies launch-signoff promotion policy", () => {
  const result = validateLaunchSignoffPolicy({
    rootDir: new URL("../..", import.meta.url).pathname,
  });

  assert.deepEqual(result.errors, []);
});

test("reports missing launch-signoff job and branch-protection context", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-launch-signoff-"));
  try {
    mkdirSync(path.join(tmp, ".github", "workflows"), { recursive: true });
    mkdirSync(path.join(tmp, "scripts", "ci"), { recursive: true });
    mkdirSync(path.join(tmp, "scripts", "deploy"), { recursive: true });
    mkdirSync(path.join(tmp, "docker"), { recursive: true });
    mkdirSync(path.join(tmp, "doc"), { recursive: true });

    writeFileSync(path.join(tmp, ".github", "workflows", "pr.yml"), "jobs:\n  verify:\n    steps: []\n");
    writeFileSync(path.join(tmp, ".github", "CODEOWNERS"), ".github/** @owner\n");
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(path.join(tmp, "doc", "BRANCH-PROTECTION.md"), "Required checks: verify\n");
    writeFileSync(path.join(tmp, "doc", "MAC-MINI-DEPLOYMENT.md"), "readiness only\n");
    writeFileSync(path.join(tmp, "doc", "VPS-DEPLOYMENT.md"), "ota only\n");
    writeFileSync(path.join(tmp, "docker", "docker-compose.production.yml"), "services: {}\n");

    const result = validateLaunchSignoffPolicy({ rootDir: tmp });

    assert.match(result.errors.join("\n"), /launch-signoff job/);
    assert.match(result.errors.join("\n"), /Branch protection.*launch-signoff/);
    assert.match(result.errors.join("\n"), /CODEOWNERS.*scripts\/deploy/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
