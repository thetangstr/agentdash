import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const builder = path.join(scriptsDir, "build-release-control-assets.mjs");

test("builds checksummed release-control assets with source and control provenance", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-release-control-"));
  try {
    const sourceScript = path.join(tmp, "source-control.mjs");
    const outputDir = path.join(tmp, "out");
    const content = "#!/usr/bin/env node\nconsole.log('control');\n";
    writeFileSync(sourceScript, content, { mode: 0o755 });

    execFileSync(process.execPath, [
      builder,
      "--version", "2026.827.0",
      "--source-sha", "f552df77417143fd6a949eff8553b98578317f5e",
      "--control-sha", "0123456789abcdef0123456789abcdef01234567",
      "--source-script", sourceScript,
      "--output-dir", outputDir,
    ]);

    const assetName = "agentdash-mac-mini-source-launchd-v2026.827.0.mjs";
    const assetPath = path.join(outputDir, assetName);
    const checksumPath = `${assetPath}.sha256`;
    const manifestPath = path.join(outputDir, "agentdash-release-control-v2026.827.0.json");
    const expectedHash = createHash("sha256").update(content).digest("hex");

    assert.equal(readFileSync(assetPath, "utf8"), content);
    assert.equal(statSync(assetPath).mode & 0o777, 0o755);
    assert.equal(readFileSync(checksumPath, "utf8"), `${expectedHash}  ${assetName}\n`);
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), {
      version: 1,
      releaseVersion: "2026.827.0",
      sourceSha: "f552df77417143fd6a949eff8553b98578317f5e",
      releaseControlSha: "0123456789abcdef0123456789abcdef01234567",
      updaterAsset: assetName,
      updaterSha256: expectedHash,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
