import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const builder = path.join(scriptsDir, "build-release-control-assets.mjs");
const releaseAssets = await import("./build-release-control-assets.mjs");

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

test("builds an owned connector tarball with application and control provenance", () => {
  assert.equal(typeof releaseAssets.buildAgentDashConnectReleaseAssets, "function");

  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-connect-release-"));
  try {
    const packageDir = path.join(tmp, "connect");
    const outputDir = path.join(tmp, "out");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({
        name: "agentdash-connect",
        version: "0.1.5",
        type: "module",
        files: ["index.mjs"],
      }, null, 2)}\n`,
    );
    writeFileSync(path.join(packageDir, "index.mjs"), "export const ready = true;\n");

    const result = releaseAssets.buildAgentDashConnectReleaseAssets({
      packageDir,
      applicationSourceSha: "f552df77417143fd6a949eff8553b98578317f5e",
      releaseControlSha: "0123456789abcdef0123456789abcdef01234567",
      outputDir,
    });

    const tarballName = "agentdash-connect-v0.1.5.tgz";
    const tarball = readFileSync(path.join(outputDir, tarballName));
    const expectedHash = createHash("sha256").update(tarball).digest("hex");
    assert.equal(
      readFileSync(path.join(outputDir, `${tarballName}.sha256`), "utf8"),
      `${expectedHash}  ${tarballName}\n`,
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(path.join(outputDir, "agentdash-connect-release-v0.1.5.json"), "utf8"),
      ),
      {
        version: 1,
        packageName: "agentdash-connect",
        packageVersion: "0.1.5",
        packageTag: "agentdash-connect-v0.1.5",
        applicationSourceSha: "f552df77417143fd6a949eff8553b98578317f5e",
        releaseControlSha: "0123456789abcdef0123456789abcdef01234567",
        tarballAsset: tarballName,
        tarballSha256: expectedHash,
        npmIntegrity: result.npmIntegrity,
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
