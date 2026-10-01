#!/usr/bin/env node
// Generate docs/api/route-index.md: every HTTP route the server registers,
// grouped by route file, with the file's mount prefix resolved from
// server/src/app.ts and a mark on the routes the public contract covers
// (docs/api/contract.json). Everything not in the contract is labelled
// internal. doc/plans/2026-10-01-public-docs-section.md, "Generated references
// and drift checks".
//
// What it reads, and how:
//   - server/src/routes/*.ts — every `router.<get|post|put|patch|delete>(` call
//     and every `router.use("<path>", …)`, whatever the line breaks. The first
//     argument must be a string literal ("…", '…' or `…`); a template literal
//     may use `${name}` where `name` is a `const name = "…"` in the same file.
//     Anything else is reported as unparsed, never guessed.
//   - server/src/app.ts — the `api.use(…)` / `app.use(…)` calls that mount a
//     route factory imported from ./routes/<file>.js. `api` is the Router
//     mounted at /api; `app` is the root. A string first argument adds to the
//     prefix. A file with no mount of its own, whose `registerXRoutes(router)`
//     is called from another route file, inherits that file's mount.
//
// Output is deterministic: no timestamps, no commit hash (a hash would change
// on the very commit that adds the file, so the drift check could never pass).
// The header carries a digest of the extracted route list instead — it changes
// exactly when a route is added, removed, renamed or remounted.
//
// Usage: node scripts/docs/generate-route-index.mjs [--check] [--out <dir>]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROUTE_INDEX_REL = "docs/api/route-index.md";
export const CONTRACT_REL = "docs/api/contract.json";
const ROUTES_DIR_REL = "server/src/routes";
const APP_REL = "server/src/app.ts";

/**
 * Route files whose routes are counted but not listed. The route index is a
 * public page, and these files' names and paths name things kept off the site:
 * a client's product profile (the plan's Decisions, item 3) or a specific
 * engagement. The routes stay internal; nothing about them is promised. The
 * value is the reason the page prints next to the count.
 */
export const WITHHELD_ROUTE_FILES = {
  "agentdash-mk-inbox.ts": "serving a private product profile",
  "ross-requests.ts": "engagement-specific",
};

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

/**
 * Blank out comments, keeping string literals and every character offset (so
 * line numbers survive). A tiny lexer: strings, template literals (without
 * nested-expression awareness beyond `${…}` brace counting), line and block
 * comments, and regex literals are not distinguished from division — route
 * files do not put a `//` inside a regex, and a miss shows up as unparsed.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Index just past the string literal that starts at `start`. */
function skipString(source, start) {
  const quote = source[start];
  let i = start + 1;
  let depth = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`") {
      if (depth === 0 && c === "`") return i + 1;
      if (c === "$" && source[i + 1] === "{") {
        depth += 1;
        i += 2;
        continue;
      }
      if (depth > 0 && c === "}") depth -= 1;
      i += 1;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === "\n") return i + 1; // unterminated; stop at the line
    i += 1;
  }
  return i;
}

/** Index just past the `)` that closes the `(` at `open`. */
function matchParen(source, open) {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(source, i);
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return source.length;
}

function lineAt(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/** `const name = "…"` / `'…'` declarations in a file, for `${name}` in a template literal. */
function stringConstants(source) {
  const out = new Map();
  for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])([^"'\n]*)\2\s*;/g)) {
    out.set(match[1], match[3]);
  }
  return out;
}

/**
 * The string-literal value at `offset` (after whitespace), or null if the
 * argument there is not a literal this scanner can read.
 */
function readLiteral(source, offset, constants) {
  let i = offset;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const end = skipString(source, i);
  const body = source.slice(i + 1, end - 1);
  if (quote !== "`") return body.includes("\\") ? null : body;
  let unresolved = false;
  const value = body.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (_whole, name) => {
    if (!constants.has(name)) {
      unresolved = true;
      return "";
    }
    return constants.get(name);
  });
  if (unresolved || value.includes("${")) return null;
  return value;
}

/** Routes registered in one route file's source. */
export function extractRoutes(source) {
  const clean = stripComments(source);
  const constants = stringConstants(clean);
  const routes = [];
  const unparsed = [];
  const pattern = /\brouter\s*\.\s*(get|post|put|patch|delete|use)\s*\(/g;
  for (const match of clean.matchAll(pattern)) {
    const verb = match[1];
    const argStart = match.index + match[0].length;
    const line = lineAt(clean, match.index);
    const value = readLiteral(clean, argStart, constants);
    if (verb === "use") {
      // Only a path-scoped use() is an endpoint family; a bare middleware is not a route.
      if (value !== null) routes.push({ method: "ANY", path: value, line });
      continue;
    }
    if (value === null) {
      unparsed.push({ method: verb.toUpperCase(), line, text: clean.slice(argStart, argStart + 60).trim().split("\n")[0] });
      continue;
    }
    routes.push({ method: verb.toUpperCase(), path: value, line });
  }
  return { routes, unparsed };
}

/**
 * Mount prefixes per route file, from app.ts. Returns a map
 * `file.ts → string[]` (a file can be mounted more than once).
 */
export function resolveMounts(appSource) {
  const clean = stripComments(appSource);
  const factoryToFile = new Map();
  for (const match of clean.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/routes\/([\w.-]+)\.js["']/g)) {
    for (const name of match[1].split(",").map((part) => part.trim().split(/\s+as\s+/).pop()?.trim()).filter(Boolean)) {
      factoryToFile.set(name, `${match[2]}.ts`);
    }
  }
  const mounts = new Map();
  for (const match of clean.matchAll(/\b(api|app)\s*\.\s*use\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(clean, open);
    const args = clean.slice(open + 1, close - 1);
    const literal = readLiteral(args, 0, new Map());
    const base = match[1] === "api" ? "/api" : "";
    const prefix = joinPath(base, literal ?? "");
    for (const call of args.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const file = factoryToFile.get(call[1]);
      if (!file) continue;
      if (!mounts.has(file)) mounts.set(file, []);
      if (!mounts.get(file).includes(prefix)) mounts.get(file).push(prefix);
    }
  }
  return mounts;
}

function joinPath(prefix, tail) {
  if (!tail || tail === "/") return prefix || "/";
  const joined = `${prefix.replace(/\/+$/, "")}/${tail.replace(/^\/+/, "")}`;
  return joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
}

/**
 * Everything the index needs, from a repo checkout: per file, its mounts and
 * its routes with full paths; plus what could not be parsed or mounted.
 */
export function collectRouteIndex(repoRoot) {
  const routesDir = path.join(repoRoot, ROUTES_DIR_REL);
  const files = readdirSync(routesDir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")).sort();
  const mounts = resolveMounts(readFileSync(path.join(repoRoot, APP_REL), "utf8"));

  // A `registerXRoutes(router)` file inherits the mount of the file that calls it.
  const sources = new Map(files.map((file) => [file, readFileSync(path.join(routesDir, file), "utf8")]));
  for (const [file, source] of sources) {
    if (mounts.has(file)) continue;
    const exported = [...stripComments(source).matchAll(/export\s+function\s+(register[A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]);
    for (const name of exported) {
      for (const [caller, callerSource] of sources) {
        if (caller === file || !mounts.has(caller)) continue;
        if (new RegExp(`\\b${name}\\s*\\(\\s*router\\b`).test(stripComments(callerSource))) {
          mounts.set(file, [...mounts.get(caller)]);
        }
      }
    }
  }

  const groups = [];
  const unparsed = [];
  const unmounted = [];
  const withheld = { files: 0, routes: 0, reasons: {} };
  for (const file of files) {
    const { routes, unparsed: missed } = extractRoutes(sources.get(file));
    for (const miss of missed) unparsed.push({ file, ...miss });
    if (routes.length === 0) continue;
    const prefixes = mounts.get(file);
    if (!prefixes || prefixes.length === 0) {
      unmounted.push({ file, routes: routes.length });
      continue;
    }
    const full = [];
    for (const prefix of prefixes) {
      for (const route of routes) full.push({ method: route.method, path: joinPath(prefix, route.path), line: route.line });
    }
    const reason = Object.hasOwn(WITHHELD_ROUTE_FILES, file) ? WITHHELD_ROUTE_FILES[file] : null;
    if (reason) {
      withheld.files += 1;
      withheld.routes += full.length;
      withheld.reasons[reason] ??= { files: 0, routes: 0 };
      withheld.reasons[reason].files += 1;
      withheld.reasons[reason].routes += full.length;
      continue;
    }
    groups.push({ file, prefixes, routes: full });
  }
  return { groups, unparsed, unmounted, withheld };
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export function readContract(repoRoot) {
  const file = path.join(repoRoot, CONTRACT_REL);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Where an operation is on the rendered reference: `/api/reference#tag/<tag>/<operationId>`
 * (docs-relative; the docs renderer prefixes `/docs`). The operation part is the
 * operationId because ui/src/components/docs/ApiReference.tsx sets Scalar's
 * `generateOperationSlug` to it (ui/src/lib/api-reference-server.ts).
 */
export function referenceAnchor(tag, operationId) {
  return `/api/reference#tag/${tag}/${operationId}`;
}

export function routeKey(method, routePath) {
  return `${method.toUpperCase()} ${routePath}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|");
}

export function renderRouteIndex(index, contract) {
  const inContract = new Map();
  const tagPages = new Map();
  for (const tag of contract?.tags ?? []) tagPages.set(tag.name, tag.page ?? null);
  for (const route of contract?.routes ?? []) inContract.set(routeKey(route.method, route.path), route);

  const total = index.groups.reduce((sum, group) => sum + group.routes.length, 0) + index.withheld.routes;
  const listed = total - index.withheld.routes;
  const contracted = index.groups.reduce(
    (sum, group) => sum + group.routes.filter((route) => inContract.has(routeKey(route.method, route.path))).length,
    0,
  );
  const digest = createHash("sha256")
    .update(index.groups.map((group) => group.routes.map((route) => `${group.file} ${route.method} ${route.path}`).join("\n")).join("\n"))
    .update(`\nwithheld ${JSON.stringify(Object.entries(index.withheld.reasons ?? {}).sort())}`)
    .digest("hex")
    .slice(0, 12);

  const lines = [
    "---",
    "title: Route index",
    'summary: "Every HTTP route the server registers, generated from the route files. Only routes marked as in the contract are promised."',
    "---",
    "",
    "<!-- Generated by scripts/docs/generate-route-index.mjs. Do not edit by hand; run `node scripts/docs/generate-route-index.mjs`. -->",
    "",
    `**Measured:** ${total} routes in ${index.groups.length + index.withheld.files} route files under \`server/src/routes/\`, counted by \`scripts/docs/generate-route-index.mjs\` from each \`router.<method>(\` call and resolved against the mounts in \`server/src/app.ts\`. Route-list digest \`${digest}\`; it changes exactly when a route is added, removed, renamed or remounted, so \`git log -S ${digest} -- ${ROUTE_INDEX_REL}\` finds the commit that generated this page.`,
    "",
    `**In the contract:** ${contracted} of them. Those are the operations in [the API reference](/api/reference), and each one is a promise: it will not be removed or renamed without a deprecation cycle. ${contract ? "" : "(No contract manifest was found when this page was generated.)"}`.trimEnd(),
    "",
    "**Everything else is internal and may change without notice.** It is listed so you can see what exists, not so you can build on it. If you need one of these routes, ask for it to be added to the contract.",
    "",
  ];
  for (const [reason, count] of Object.entries(index.withheld.reasons ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `Withheld, ${reason}: ${count.routes} route${count.routes === 1 ? "" : "s"} in ${count.files} file${count.files === 1 ? "" : "s"}, counted above but not listed.`,
      "",
    );
  }
  if (index.unparsed.length > 0) {
    lines.push(
      `${index.unparsed.length} registration${index.unparsed.length === 1 ? "" : "s"} could not be read (the path is not a string literal) and ${index.unparsed.length === 1 ? "is" : "are"} not counted:`,
      "",
    );
    for (const miss of index.unparsed) lines.push(`- \`${miss.file}:${miss.line}\` ${miss.method}`);
    lines.push("");
  }
  if (index.unmounted.length > 0) {
    lines.push("Route files with routes but no mount found in `server/src/app.ts` (not counted):", "");
    for (const entry of index.unmounted) lines.push(`- \`${entry.file}\` (${entry.routes} routes)`);
    lines.push("");
  }

  for (const group of index.groups) {
    lines.push(`## ${group.file.replace(/\.ts$/, "")}`, "");
    lines.push(`Source: \`${ROUTES_DIR_REL}/${group.file}\` · mounted at ${group.prefixes.map((prefix) => `\`${prefix}\``).join(", ")}`, "");
    lines.push("| Method | Path | Status |", "| --- | --- | --- |");
    for (const route of group.routes) {
      const entry = inContract.get(routeKey(route.method, route.path));
      let status = "internal";
      if (entry) {
        const page = tagPages.get(entry.tag);
        status = `contract: [\`${entry.operationId}\`](${referenceAnchor(entry.tag, entry.operationId)})${page ? ` · [guide](/${page})` : ""}`;
      }
      lines.push(`| ${route.method} | \`${escapeCell(route.path)}\` | ${status} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function buildRouteIndex(repoRoot) {
  return renderRouteIndex(collectRouteIndex(repoRoot), readContract(repoRoot));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const args = process.argv.slice(2);
  const next = buildRouteIndex(repoRoot);
  const index = collectRouteIndex(repoRoot);
  for (const miss of index.unparsed) console.warn(`unparsed: ${miss.file}:${miss.line} ${miss.method} ${miss.text}`);
  for (const entry of index.unmounted) console.warn(`unmounted: ${entry.file} (${entry.routes} routes)`);
  if (args.includes("--check")) {
    const target = path.join(repoRoot, ROUTE_INDEX_REL);
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current !== next) {
      console.error(`${ROUTE_INDEX_REL} is stale. Run: node scripts/docs/generate-route-index.mjs`);
      process.exit(1);
    }
    console.log(`${ROUTE_INDEX_REL} is current.`);
    return;
  }
  const outIndex = args.indexOf("--out");
  const outDir = outIndex !== -1 ? path.resolve(args[outIndex + 1]) : repoRoot;
  const target = path.join(outDir, ROUTE_INDEX_REL);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, next);
  const total = index.groups.reduce((sum, group) => sum + group.routes.length, 0) + index.withheld.routes;
  console.log(`Wrote ${path.relative(process.cwd(), target) || target} (${total} routes, ${index.unparsed.length} unparsed).`);
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
  main();
}
