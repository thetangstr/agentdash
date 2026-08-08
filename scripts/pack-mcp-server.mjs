#!/usr/bin/env node
/**
 * Build the MCP client package and pack it to a stable filename the server can
 * serve at /downloads/agentdash-mcp-server.tgz.
 *
 * The filename deliberately carries no version. The connect command shown on a
 * person's My Agent page is copied into their MCP config and stays there, so a
 * versioned URL would break every existing install on the next release. The
 * tarball itself still carries its version; only the path is stable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "packages", "mcp-server");
const stable = join(pkgDir, "agentdash-mcp-server.tgz");

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });

console.log("building @agentdash/mcp-server…");
run("pnpm", ["--filter", "@agentdash/mcp-server", "build"], root);

if (existsSync(stable)) rmSync(stable);

console.log("packing…");
run("npm", ["pack", "--pack-destination", pkgDir], pkgDir);

// `npm pack` names the file from the package name and version; rename it to the
// stable path the route serves.
const packed = readdirSync(pkgDir)
  .filter((name) => name.startsWith("agentdash-mcp-server-") && name.endsWith(".tgz"))
  .sort();
if (packed.length === 0) {
  console.error("npm pack produced no tarball");
  process.exit(1);
}
// Keep the newest if several are lying around, and clear the rest so the
// directory cannot accumulate stale copies that look current.
const newest = packed[packed.length - 1];
for (const name of packed.slice(0, -1)) rmSync(join(pkgDir, name));
renameSync(join(pkgDir, newest), stable);

// Also place it where a published server build looks first, when that directory
// exists — a packaged install has no packages/ tree to fall back to.
const serverCopy = join(root, "server", "mcp-dist");
if (existsSync(join(root, "server"))) {
  mkdirSync(serverCopy, { recursive: true });
  const { copyFileSync } = await import("node:fs");
  copyFileSync(stable, join(serverCopy, "agentdash-mcp-server.tgz"));
}

console.log(`packed ${newest} → ${stable}`);
