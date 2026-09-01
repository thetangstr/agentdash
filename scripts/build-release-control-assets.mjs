#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

function requireValue(value, label, pattern) {
  const normalized = String(value ?? "").trim();
  if (!pattern.test(normalized)) {
    throw new Error(`${label} is invalid: ${normalized || "<empty>"}`);
  }
  return normalized;
}

export function buildReleaseControlAssets(input) {
  const releaseVersion = requireValue(
    input.releaseVersion,
    "release version",
    /^\d+\.\d+\.\d+$/,
  );
  const sourceSha = requireValue(input.sourceSha, "source SHA", /^[0-9a-f]{40}$/i);
  const releaseControlSha = requireValue(
    input.releaseControlSha,
    "release-control SHA",
    /^[0-9a-f]{40}$/i,
  );
  const sourceScript = path.resolve(input.sourceScript);
  const outputDir = path.resolve(input.outputDir);
  const updaterAsset = `agentdash-mac-mini-source-launchd-v${releaseVersion}.mjs`;
  const updaterPath = path.join(outputDir, updaterAsset);
  const checksumPath = `${updaterPath}.sha256`;
  const manifestPath = path.join(
    outputDir,
    `agentdash-release-control-v${releaseVersion}.json`,
  );

  mkdirSync(outputDir, { recursive: true });
  copyFileSync(sourceScript, updaterPath);
  chmodSync(updaterPath, 0o755);

  const updaterSha256 = createHash("sha256")
    .update(readFileSync(updaterPath))
    .digest("hex");
  writeFileSync(checksumPath, `${updaterSha256}  ${updaterAsset}\n`, { mode: 0o644 });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      releaseVersion,
      sourceSha,
      releaseControlSha,
      updaterAsset,
      updaterSha256,
    }, null, 2)}\n`,
    { mode: 0o644 },
  );

  return { updaterPath, checksumPath, manifestPath };
}

export function buildAgentDashConnectReleaseAssets(input) {
  const applicationSourceSha = requireValue(
    input.applicationSourceSha,
    "application source SHA",
    /^[0-9a-f]{40}$/i,
  );
  const releaseControlSha = requireValue(
    input.releaseControlSha,
    "release-control SHA",
    /^[0-9a-f]{40}$/i,
  );
  const packageDir = path.resolve(input.packageDir);
  const outputDir = path.resolve(input.outputDir);
  const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  if (packageJson.name !== "agentdash-connect") {
    throw new Error(`connector package name is invalid: ${packageJson.name ?? "<missing>"}`);
  }
  const packageVersion = requireValue(
    packageJson.version,
    "connector package version",
    /^\d+\.\d+\.\d+$/,
  );

  mkdirSync(outputDir, { recursive: true });
  const packResult = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", outputDir],
      { cwd: packageDir, encoding: "utf8" },
    ),
  );
  if (!Array.isArray(packResult) || packResult.length !== 1) {
    throw new Error("npm pack did not return exactly one connector tarball");
  }

  const packed = packResult[0];
  const originalTarballPath = path.join(outputDir, path.basename(packed.filename));
  const tarballAsset = `agentdash-connect-v${packageVersion}.tgz`;
  const tarballPath = path.join(outputDir, tarballAsset);
  renameSync(originalTarballPath, tarballPath);
  const tarballSha256 = createHash("sha256")
    .update(readFileSync(tarballPath))
    .digest("hex");
  const checksumPath = `${tarballPath}.sha256`;
  const manifestPath = path.join(
    outputDir,
    `agentdash-connect-release-v${packageVersion}.json`,
  );
  const npmIntegrity = requireValue(
    packed.integrity,
    "npm pack integrity",
    /^sha512-[A-Za-z0-9+/=]+$/,
  );

  writeFileSync(checksumPath, `${tarballSha256}  ${tarballAsset}\n`, { mode: 0o644 });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      packageName: "agentdash-connect",
      packageVersion,
      packageTag: `agentdash-connect-v${packageVersion}`,
      applicationSourceSha,
      releaseControlSha,
      tarballAsset,
      tarballSha256,
      npmIntegrity,
    }, null, 2)}\n`,
    { mode: 0o644 },
  );

  return { tarballPath, checksumPath, manifestPath, npmIntegrity };
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      "source-sha": { type: "string" },
      "control-sha": { type: "string" },
      "source-script": { type: "string" },
      "connect-package-dir": { type: "string" },
      "output-dir": { type: "string" },
    },
  });

  const result = values["connect-package-dir"]
    ? buildAgentDashConnectReleaseAssets({
        packageDir: values["connect-package-dir"],
        applicationSourceSha: values["source-sha"],
        releaseControlSha: values["control-sha"],
        outputDir: values["output-dir"],
      })
    : buildReleaseControlAssets({
        releaseVersion: values.version,
        sourceSha: values["source-sha"],
        releaseControlSha: values["control-sha"],
        sourceScript: values["source-script"],
        outputDir: values["output-dir"],
      });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`[build-release-control-assets] ${error.message}`);
    process.exitCode = 1;
  }
}
