#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const PUBLISH_MANIFEST_KEYS = ["exports", "main", "types", "bin"];
const PUBLISH_CONFIG_KEYS_TO_KEEP = ["access", "registry", "tag", "provenance"];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  // pnpm deploy may hardlink manifests; replace the path so the source package stays untouched.
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tempPath, filePath);
}

function isWithinRoot(filePath, rootPath) {
  const root = realpathSync(rootPath);
  const file = realpathSync(filePath);
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function packageJsonPath(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!existsSync(resolved)) return null;
  if (statSync(resolved).isFile()) return path.basename(resolved) === "package.json" ? resolved : null;
  const candidate = path.join(resolved, "package.json");
  return existsSync(candidate) ? candidate : null;
}

function addPackage(candidates, inputPath, allowedRoot) {
  const pkgPath = packageJsonPath(inputPath);
  if (pkgPath && allowedRoot && !isWithinRoot(pkgPath, allowedRoot)) return;
  if (pkgPath) candidates.add(pkgPath);
}

function addPaperclipDependencies(candidates, appRoot) {
  const scopedRoot = path.join(appRoot, "node_modules", "@paperclipai");
  if (!existsSync(scopedRoot)) return;

  for (const entry of readdirSync(scopedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    addPackage(candidates, path.join(scopedRoot, entry.name), appRoot);
  }
}

function applyPublishConfig(pkgPath) {
  const pkg = readJson(pkgPath);
  const publishConfig = pkg.publishConfig;
  if (!publishConfig || typeof publishConfig !== "object" || Array.isArray(publishConfig)) {
    return false;
  }

  let changed = false;
  for (const key of PUBLISH_MANIFEST_KEYS) {
    if (!(key in publishConfig)) continue;
    pkg[key] = publishConfig[key];
    changed = true;
  }

  const retainedPublishConfig = {};
  for (const key of PUBLISH_CONFIG_KEYS_TO_KEEP) {
    if (key in publishConfig) retainedPublishConfig[key] = publishConfig[key];
  }
  if (Object.keys(retainedPublishConfig).length > 0) {
    pkg.publishConfig = retainedPublishConfig;
  } else {
    delete pkg.publishConfig;
  }

  if (changed) writeJson(pkgPath, pkg);
  return changed;
}

function main() {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error("Usage: node scripts/apply-publish-config-manifest.mjs <package-or-deploy-root> [...]");
    process.exit(1);
  }

  const candidates = new Set();
  for (const input of inputs) {
    const root = path.resolve(input);
    addPackage(candidates, root, root);
    addPaperclipDependencies(candidates, root);
  }

  let updated = 0;
  for (const pkgPath of [...candidates].sort()) {
    if (applyPublishConfig(pkgPath)) updated += 1;
  }

  console.log(`Applied publishConfig manifest fields to ${updated} package manifest(s).`);
}

main();
