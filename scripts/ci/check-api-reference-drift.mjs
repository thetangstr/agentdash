#!/usr/bin/env node
// AgentDash CI guard: the public API reference cannot drift from the server
// (doc/plans/2026-10-01-public-docs-section.md, "Generated references and drift
// checks").
//
// Two checks:
//   (a) every route in docs/api/contract.json exists in a freshly generated
//       route index — a renamed, removed or remounted contract route fails,
//       because the contract promised it;
//   (b) regenerating docs/api/route-index.md and docs/api/openapi.yaml into a
//       temp dir reproduces the committed files byte for byte — a changed
//       route, validator or type fails until the reference is regenerated.
// Plus the contract's own shape: unique operationIds, known tags, the fields
// every entry must carry.
//
// `--routes-only` runs everything except the OpenAPI regeneration, which needs
// the workspace installed (it loads @paperclipai/shared through tsx and the two
// schema converters). The PR workflow's `policy` job has no install, so it runs
// `--routes-only`; `verify-build`, which installs, runs the full check.
//
// Usage: node scripts/ci/check-api-reference-drift.mjs [--routes-only] [--root <repo>]

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CONTRACT_REL,
  ROUTE_INDEX_REL,
  collectRouteIndex,
  renderRouteIndex,
  routeKey,
} from "../docs/generate-route-index.mjs";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const STABILITIES = new Set(["stable"]);
const REQUIRED_FIELDS = ["tag", "operationId", "summary", "method", "path", "requestValidator", "responseType", "stability"];

/** Shape errors in a parsed contract.json. */
export function checkContractShape(contract) {
  const errors = [];
  if (!contract || !Array.isArray(contract.routes)) return ["contract.json has no `routes` array"];
  const tags = new Set((contract.tags ?? []).map((tag) => tag.name));
  const operationIds = new Set();
  const keys = new Set();
  contract.routes.forEach((route, index) => {
    const where = `routes[${index}]${route?.operationId ? ` (${route.operationId})` : ""}`;
    for (const field of REQUIRED_FIELDS) {
      if (!(field in (route ?? {}))) errors.push(`${where}: missing \`${field}\``);
    }
    if (route.method && !METHODS.has(route.method)) errors.push(`${where}: method ${route.method} is not one of ${[...METHODS].join(", ")}`);
    if (route.stability && !STABILITIES.has(route.stability)) errors.push(`${where}: stability ${route.stability} is not one of ${[...STABILITIES].join(", ")}`);
    if (route.tag && !tags.has(route.tag)) errors.push(`${where}: tag ${route.tag} is not in \`tags\``);
    if (typeof route.summary === "string" && (route.summary.trim() === "" || route.summary.includes("\n"))) {
      errors.push(`${where}: summary must be one non-empty line`);
    }
    if (route.operationId) {
      if (operationIds.has(route.operationId)) errors.push(`${where}: duplicate operationId`);
      operationIds.add(route.operationId);
    }
    if (route.method && route.path) {
      const key = routeKey(route.method, route.path);
      if (keys.has(key)) errors.push(`${where}: ${key} is listed twice`);
      keys.add(key);
    }
  });
  return errors;
}

/** (a): contract routes missing from a route index (as collectRouteIndex returns it). */
export function checkContractRoutesExist(contract, index) {
  const present = new Set();
  for (const group of index.groups) for (const route of group.routes) present.add(routeKey(route.method, route.path));
  return (contract?.routes ?? [])
    .filter((route) => !present.has(routeKey(route.method, route.path)))
    .map(
      (route) =>
        `${route.operationId}: ${routeKey(route.method, route.path)} is in docs/api/contract.json but the server no longer registers it. ` +
        "A contract route cannot be renamed or removed silently: restore it, or remove it from the contract with a deprecation note.",
    );
}

/** (b): a committed generated file against a fresh one, by path. */
export function compareGenerated(rel, committed, fresh, command) {
  if (committed === fresh) return [];
  if (committed === null) return [`${rel} is missing. Run: ${command}`];
  const a = committed.split("\n");
  const b = fresh.split("\n");
  let line = 0;
  while (line < a.length && line < b.length && a[line] === b[line]) line += 1;
  return [`${rel} is stale (first difference at line ${line + 1}). Run: ${command}`];
}

function readOrNull(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export async function runChecks(repoRoot, { routesOnly = false } = {}) {
  const errors = [];
  const notes = [];
  const contract = JSON.parse(readFileSync(path.join(repoRoot, CONTRACT_REL), "utf8"));
  errors.push(...checkContractShape(contract));

  const index = collectRouteIndex(repoRoot);
  errors.push(...checkContractRoutesExist(contract, index));

  const temp = mkdtempSync(path.join(tmpdir(), "api-reference-drift-"));
  try {
    const freshIndex = renderRouteIndex(index, contract);
    const indexOut = path.join(temp, ROUTE_INDEX_REL);
    mkdirSync(path.dirname(indexOut), { recursive: true });
    writeFileSync(indexOut, freshIndex);
    errors.push(
      ...compareGenerated(
        ROUTE_INDEX_REL,
        readOrNull(path.join(repoRoot, ROUTE_INDEX_REL)),
        readFileSync(indexOut, "utf8"),
        "node scripts/docs/generate-route-index.mjs",
      ),
    );

    if (routesOnly) {
      notes.push("OpenAPI regeneration skipped (--routes-only); verify-build runs it.");
    } else {
      const generator = await import(pathToFileURL(path.join(repoRoot, "scripts", "docs", "generate-openapi.mjs")).href);
      const { yaml, unconverted } = await generator.buildOpenApiYaml(repoRoot);
      const yamlOut = path.join(temp, generator.OPENAPI_REL);
      mkdirSync(path.dirname(yamlOut), { recursive: true });
      writeFileSync(yamlOut, yaml);
      errors.push(
        ...compareGenerated(
          generator.OPENAPI_REL,
          readOrNull(path.join(repoRoot, generator.OPENAPI_REL)),
          readFileSync(yamlOut, "utf8"),
          "node scripts/docs/generate-openapi.mjs",
        ),
      );
      for (const entry of unconverted) notes.push(`schema not generated: ${entry.kind} ${entry.name}`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return { errors, notes, contractRoutes: contract.routes.length };
}

async function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const repoRoot = rootIndex !== -1
    ? path.resolve(args[rootIndex + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { errors, notes, contractRoutes } = await runChecks(repoRoot, { routesOnly: args.includes("--routes-only") });
  for (const note of notes) console.log(note);
  if (errors.length > 0) {
    console.error("API reference drift:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`API reference is current: ${contractRoutes} contract routes, all registered.`);
}

// Entry guard: resolve symlinks on both sides, or a symlinked invocation
// silently skips main() (scripts/entry-guard.test.mjs; cf. #666).
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
if (process.argv[1] && realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))) {
  await main();
}
