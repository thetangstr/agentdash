import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkContractRoutesExist, checkContractShape, compareGenerated, runChecks } from "./check-api-reference-drift.mjs";
import { collectRouteIndex, extractRoutes, renderRouteIndex, resolveMounts, stripComments } from "../docs/generate-route-index.mjs";
// Only node builtins at the top level; the converters are imported lazily inside the build.
import { REDACTED_ENUM_VALUES, openApiPath, redactEnums, requestComponentName } from "../docs/generate-openapi.mjs";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// Everything here is dependency-free on purpose: this file runs in the PR
// workflow's `policy` job, which has no install. The OpenAPI half of the drift
// check runs in `verify-build` (`node scripts/ci/check-api-reference-drift.mjs`).

test("extracts routes across line breaks, quote styles and resolvable template literals", () => {
  const source = [
    'const base = "/companies/:companyId/workforce";',
    'router.get("/a", handler);',
    "router.post(",
    '  "/b/:id",',
    "  validate(schema),",
    "  handler,",
    ");",
    "router.patch('/c', handler);",
    "router.put(`${base}/brief`, handler);",
    'router.use("/plugins/:pluginId/api", proxy);',
    "router.use(middleware);",
  ].join("\n");
  const { routes, unparsed } = extractRoutes(source);
  assert.deepEqual(
    routes.map((route) => `${route.method} ${route.path}`),
    ["GET /a", "POST /b/:id", "PATCH /c", "PUT /companies/:companyId/workforce/brief", "ANY /plugins/:pluginId/api"],
  );
  assert.equal(routes[1].line, 3, "the line of `router.post(`, 1-based");
  assert.deepEqual(unparsed, []);
});

test("ignores registrations in comments and reports what it cannot read", () => {
  const source = [
    '// router.get("/commented", handler);',
    '/* router.post("/also-commented", handler); */',
    'router.get("http://not-a-comment//x", handler);',
    "router.get(PATH_FROM_ELSEWHERE, handler);",
    "router.delete(`${unknown}/x`, handler);",
  ].join("\n");
  const { routes, unparsed } = extractRoutes(source);
  assert.deepEqual(routes.map((route) => route.path), ["http://not-a-comment//x"]);
  assert.deepEqual(unparsed.map((miss) => [miss.method, miss.line]), [["GET", 4], ["DELETE", 5]]);
});

test("stripComments keeps offsets, so line numbers survive", () => {
  const source = "a /* x\ny */ b // z\nc";
  const clean = stripComments(source);
  assert.equal(clean.length, source.length);
  assert.equal(clean.split("\n").length, 3);
});

test("resolves mount prefixes: api is /api, app is the root, a literal first argument adds to it", () => {
  const app = [
    'import { aRoutes } from "./routes/a.js";',
    'import { bRoutes, helper } from "./routes/b.js";',
    'import { cRoutes } from "./routes/c.js";',
    'import { dRoutes } from "./routes/d.js";',
    "const api = Router();",
    "api.use(aRoutes(db));",
    'api.use("/billing", limiter, bRoutes(db, { x: f(1) }));',
    "app.use(cRoutes(db));",
    "// api.use(dRoutes(db));",
  ].join("\n");
  const mounts = resolveMounts(app);
  assert.deepEqual(mounts.get("a.ts"), ["/api"]);
  assert.deepEqual(mounts.get("b.ts"), ["/api/billing"]);
  assert.deepEqual(mounts.get("c.ts"), ["/"]);
  assert.equal(mounts.has("d.ts"), false);
});

test("a contract route the server no longer registers fails check (a)", () => {
  const index = { groups: [{ file: "x.ts", prefixes: ["/api"], routes: [{ method: "GET", path: "/api/things/:id", line: 1 }] }] };
  const contract = {
    tags: [{ name: "things" }],
    routes: [
      { tag: "things", operationId: "getThing", method: "GET", path: "/api/things/:id" },
      { tag: "things", operationId: "getWidget", method: "GET", path: "/api/widgets/:id" },
    ],
  };
  const errors = checkContractRoutesExist(contract, index);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /getWidget: GET \/api\/widgets\/:id/);
});

test("the contract's shape is checked: fields, duplicates, tags, one-line summaries", () => {
  const route = { tag: "t", operationId: "op", summary: "One line.", method: "GET", path: "/api/x", requestValidator: null, responseType: null, stability: "stable" };
  assert.deepEqual(checkContractShape({ tags: [{ name: "t" }], routes: [route] }), []);
  const errors = checkContractShape({
    tags: [{ name: "t" }],
    routes: [route, { ...route }, { ...route, operationId: "other", path: "/api/y", tag: "missing", summary: "two\nlines", stability: "beta", method: "FETCH" }, { operationId: "bare" }],
  });
  const text = errors.join("\n");
  assert.match(text, /duplicate operationId/);
  assert.match(text, /GET \/api\/x is listed twice/);
  assert.match(text, /tag missing is not in `tags`/);
  assert.match(text, /summary must be one non-empty line/);
  assert.match(text, /stability beta/);
  assert.match(text, /method FETCH/);
  assert.match(text, /routes\[3\] \(bare\): missing `summary`/);
});

test("compareGenerated names the first differing line", () => {
  assert.deepEqual(compareGenerated("f", "a\nb\n", "a\nb\n", "cmd"), []);
  assert.match(compareGenerated("f", "a\nb\n", "a\nc\n", "cmd")[0], /line 2\). Run: cmd/);
  assert.match(compareGenerated("f", null, "a", "cmd")[0], /missing/);
});

test("the route index renders deterministically and marks contract routes", () => {
  const index = {
    groups: [{ file: "x.ts", prefixes: ["/api"], routes: [{ method: "GET", path: "/api/things", line: 1 }, { method: "POST", path: "/api/things", line: 2 }] }],
    unparsed: [],
    unmounted: [],
    withheld: { files: 0, routes: 0 },
  };
  const contract = { tags: [{ name: "things", page: "api/things" }], routes: [{ tag: "things", operationId: "listThings", method: "GET", path: "/api/things" }] };
  const once = renderRouteIndex(index, contract);
  assert.equal(once, renderRouteIndex(index, contract));
  assert.match(once, /\| GET \| `\/api\/things` \| contract: \[`listThings`\]\(\/api\/reference\) · \[guide\]\(\/api\/things\) \|/);
  assert.match(once, /\| POST \| `\/api\/things` \| internal \|/);
  assert.match(once, /\*\*Measured:\*\* 2 routes in 1 route files/);
  assert.doesNotMatch(once, /\b[0-9a-f]{40}\b/, "no commit hash: it would change on the commit that adds the file");
});

test("the real repo: every route parses, every file is mounted, and every contract route exists", () => {
  const index = collectRouteIndex(REPO_ROOT);
  assert.deepEqual(index.unparsed, [], "a registration the scanner cannot read is not counted; make its path a literal");
  assert.deepEqual(index.unmounted, [], "a route file with routes but no mount in app.ts");
  const contract = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs", "api", "contract.json"), "utf8"));
  assert.deepEqual(checkContractShape(contract), []);
  assert.deepEqual(checkContractRoutesExist(contract, index), []);
  const total = index.groups.reduce((sum, group) => sum + group.routes.length, 0);
  assert.ok(total > 500, `only ${total} routes found; the scanner has stopped seeing most of them`);
});

test("the real repo: the committed route index is current (--routes-only)", async () => {
  const { errors } = await runChecks(REPO_ROOT, { routesOnly: true });
  assert.deepEqual(errors, []);
});

test("a renamed contract route fails the whole check", async () => {
  // A copy of just the inputs, with one contract route renamed in its file.
  const root = mkdtempSync(path.join(tmpdir(), "api-drift-test-"));
  try {
    for (const rel of ["server/src/routes", "server/src/app.ts", "docs/api/contract.json", "docs/api/route-index.md"]) {
      cpSync(path.join(REPO_ROOT, rel), path.join(root, rel), { recursive: true });
    }
    const goals = path.join(root, "server/src/routes/goals.ts");
    writeFileSync(goals, readFileSync(goals, "utf8").replace('router.get("/goals/:id"', 'router.get("/goals/:goalId"'));
    const { errors } = await runChecks(root, { routesOnly: true });
    assert.ok(errors.some((error) => /getGoal: GET \/api\/goals\/:id is in docs\/api\/contract\.json/.test(error)), errors.join("\n"));
    assert.ok(errors.some((error) => /route-index\.md is stale/.test(error)), errors.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAPI helpers: Express paths, component names, and the private-profile redaction", () => {
  assert.equal(openApiPath("/api/companies/:companyId/issues/:id"), "/api/companies/{companyId}/issues/{id}");
  assert.equal(openApiPath("/.well-known/oauth-authorization-server"), "/.well-known/oauth-authorization-server");
  assert.equal(requestComponentName("createCompanySchema"), "CreateCompanyRequest");
  const hidden = REDACTED_ENUM_VALUES[0];
  const redacted = redactEnums({
    a: { type: "string", enum: ["default", hidden] },
    b: { anyOf: [{ const: hidden }, { type: "null" }] },
    c: { type: "string", enum: ["x", "y"] },
  });
  assert.deepEqual(redacted.a, { type: "string", enum: ["default"], description: "Other values may appear." });
  assert.deepEqual(redacted.b, { anyOf: [{ type: "null" }] });
  assert.deepEqual(redacted.c, { type: "string", enum: ["x", "y"] });
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(hidden));
});

test("the committed OpenAPI document names no private profile", () => {
  const yaml = readFileSync(path.join(REPO_ROOT, "docs", "api", "openapi.yaml"), "utf8");
  for (const value of REDACTED_ENUM_VALUES) assert.equal(yaml.includes(value), false, value);
});
