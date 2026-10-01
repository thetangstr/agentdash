import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkContractAgainstHandlers, checkContractRoutesExist, checkContractShape, checkResourcePages, compareGenerated, readApiPages, runChecks } from "./check-api-reference-drift.mjs";
import { WITHHELD_LINE_RULES, buildApiChangelog, cleanLine, isApiLine, parseRelease, renderApiChangelog, selectApiChanges, withheldReason } from "../docs/generate-api-changelog.mjs";
import { boardOnlyGuards, classifyContractRoutes, isBoardOnlyHandler, parsedSchemas } from "../docs/route-guards.mjs";
import { collectRouteIndex, extractRoutes, renderRouteIndex, resolveMounts, stripComments } from "../docs/generate-route-index.mjs";
// Only node builtins at the top level; the converters are imported lazily inside the build.
import { AUTH_SECURITY, REDACTED_ENUM_VALUES, openApiPath, redactEnums, requestComponentName, securityFor } from "../docs/generate-openapi.mjs";

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
    withheld: { files: 0, routes: 0, reasons: {} },
  };
  const contract = { tags: [{ name: "things", page: "api/things" }], routes: [{ tag: "things", operationId: "listThings", method: "GET", path: "/api/things" }] };
  const once = renderRouteIndex(index, contract);
  assert.equal(once, renderRouteIndex(index, contract));
  assert.match(once, /\| GET \| `\/api\/things` \| contract: \[`listThings`\]\(\/api\/reference#tag\/things\/listThings\) · \[guide\]\(\/api\/things\) \|/);
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
    for (const rel of ["server/src/routes", "server/src/app.ts", "docs/api", "releases"]) {
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
  assert.deepEqual(redacted.a, { type: "string", enum: ["default"], description: "1 value omitted: private. Other values may appear." });
  assert.deepEqual(redacted.b, { anyOf: [{ type: "null" }] });
  assert.deepEqual(redacted.c, { type: "string", enum: ["x", "y"] });
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(hidden));
});

test("the committed OpenAPI document names no private profile", () => {
  const yaml = readFileSync(path.join(REPO_ROOT, "docs", "api", "openapi.yaml"), "utf8");
  for (const value of REDACTED_ENUM_VALUES) assert.equal(yaml.includes(value), false, value);
});

test("a board-only guard counts only when nothing can branch around it", () => {
  const source = [
    "function requireBoardUser(req) {",
    "  assertBoard(req);",
    "  return req.actor.userId;",
    "}",
    "function maybeBoard(req) {",
    "  if (req.x) assertBoard(req);",
    "}",
    'router.get("/a", async (req, res) => {',
    "  assertBoard(req);",
    "});",
    'router.get("/b", async (req, res) => {',
    "  const thing = await load(req.params.id);",
    "  if (!thing) {",
    '    res.status(404).json({ error: "Not found" });',
    "    return;",
    "  }",
    "  assertCanSetCompanyDirection(req, thing.companyId);",
    "});",
    'router.patch("/c", async (req, res) => {',
    '  if (req.actor.type === "agent") {',
    "    body = brandingSchema.parse(req.body);",
    "  } else {",
    "    assertBoard(req);",
    "  }",
    "});",
    'router.post("/d", validate(createThingSchema), async (req, res) => {',
    "  const userId = requireBoardUser(req);",
    "});",
    'router.post("/e", async (req, res) => {',
    "  maybeBoard(req);",
    "});",
  ].join("\n");
  const guards = boardOnlyGuards(source);
  assert.ok(guards.includes("requireBoardUser"));
  assert.ok(!guards.includes("maybeBoard"));
  const lineOf = (path) => source.split("\n").findIndex((line) => line.includes(`"${path}"`)) + 1;
  assert.equal(isBoardOnlyHandler(source, lineOf("/a"), guards), true, "a guard first");
  assert.equal(isBoardOnlyHandler(source, lineOf("/b"), guards), true, "a guard after an early-return clause");
  assert.equal(isBoardOnlyHandler(source, lineOf("/c"), guards), false, "a guard in one branch lets agents through the other");
  assert.equal(isBoardOnlyHandler(source, lineOf("/d"), guards), true, "a local helper that opens with a guard");
  assert.equal(isBoardOnlyHandler(source, lineOf("/e"), guards), false, "a helper whose guard is conditional");
  assert.deepEqual(parsedSchemas(source, lineOf("/c")), ["brandingSchema"]);
  assert.deepEqual(parsedSchemas(source, lineOf("/d")), ["createThingSchema"]);
});

test("the contract must not promise agents a route that refuses them, and must name the parsed schema", () => {
  const contract = {
    routes: [
      { operationId: "boardOnly", method: "GET", path: "/api/a", requestValidator: null },
      { operationId: "boardOnlyFixed", method: "GET", path: "/api/b", auth: "board", requestValidator: null },
      { operationId: "wrongSchema", method: "POST", path: "/api/c", auth: "board", requestValidator: "createThingSchema" },
    ],
  };
  const classified = new Map([
    ["GET /api/a", { file: "x.ts", line: 1, boardOnly: true, schemas: [] }],
    ["GET /api/b", { file: "x.ts", line: 2, boardOnly: true, schemas: [] }],
    ["POST /api/c", { file: "x.ts", line: 3, boardOnly: false, schemas: ["createOtherSchema"] }],
  ]);
  const errors = checkContractAgainstHandlers(contract, classified);
  assert.equal(errors.length, 2, errors.join("\n"));
  assert.match(errors[0], /boardOnly \(server\/src\/routes\/x\.ts:1\): the handler refuses agents/);
  assert.match(errors[1], /wrongSchema .*parses createOtherSchema/);
});

test("the real repo: every route whose handler refuses agents is board-only in the spec", () => {
  const contract = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs", "api", "contract.json"), "utf8"));
  const classified = classifyContractRoutes(REPO_ROOT, contract, collectRouteIndex(REPO_ROOT));
  assert.equal(classified.size, contract.routes.length, "every contract route was located in its file");
  const boardOnly = contract.routes.filter((route) => classified.get(`${route.method} ${route.path}`).boardOnly);
  assert.ok(boardOnly.length >= 15, `only ${boardOnly.length} board-only handlers found; the scan has stopped seeing guards`);
  for (const route of boardOnly) {
    assert.ok(!securityFor(route).some((requirement) => "bearerAgentKey" in requirement), route.operationId);
  }
  assert.deepEqual(checkContractAgainstHandlers(contract, classified), []);
  // Human control authenticates through `capture()`, which takes a verified board key only.
  for (const route of contract.routes.filter((candidate) => candidate.tag === "human-control")) {
    assert.deepEqual(securityFor(route), AUTH_SECURITY["board-key"], route.operationId);
  }
});

// ---------------------------------------------------------------------------
// (e) resource pages
// ---------------------------------------------------------------------------

test("every contract tag has a page that links each of its operations, and no page links a stale anchor (e)", () => {
  const contract = {
    tags: [{ name: "things", page: "api/things" }, { name: "widgets", page: "api/widgets" }, { name: "gadgets", page: null }],
    routes: [
      { tag: "things", operationId: "listThings" },
      { tag: "things", operationId: "getThing" },
      { tag: "widgets", operationId: "listWidgets" },
    ],
  };
  const pages = new Map([
    ["api/things", "[`listThings`](/api/reference#tag/things/listThings) and nothing about the other one"],
    ["api/index", "[gone](/api/reference#tag/things/deleteThing) [nope](/api/reference#tag/nothing) [ok](/api/reference#tag/things)"],
  ]);
  const text = checkResourcePages(contract, pages).join("\n");
  assert.match(text, /getThing: docs\/api\/things\.md does not link it as \/api\/reference#tag\/things\/getThing/);
  assert.match(text, /tag widgets: its page docs\/api\/widgets\.md does not exist/);
  assert.match(text, /tag gadgets: no `page`/);
  assert.match(text, /docs\/api\/index\.md links \/api\/reference#tag\/things\/deleteThing, which is not a contract operation/);
  assert.match(text, /docs\/api\/index\.md links \/api\/reference#tag\/nothing, which is not a contract tag/);
  assert.doesNotMatch(text, /listThings/);
});

test("the real repo: every contract operation is documented on its resource page", () => {
  const contract = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs", "api", "contract.json"), "utf8"));
  assert.deepEqual(checkResourcePages(contract, readApiPages(REPO_ROOT)), []);
});

// ---------------------------------------------------------------------------
// (f) the generated API changelog
// ---------------------------------------------------------------------------

const NOTE = (version, date, body, marker = `> Released: ${date}.`) => ({ file: `${version}.md`, markdown: `# ${version}\n\n${marker}\n\nIntro prose naming GET /api/ignored is not a bullet.\n\n${body}\n` });

test("changelog: a bullet at any depth is one line, with its wrapped continuation", () => {
  const note = parseRelease([
    "# v1.0.0",
    "> Released: 2026-01-02.",
    "## Changed",
    "- **Lead** (#1). Top level",
    "  wrapped onto a second line.",
    "  - A child about `GET /api/x`.",
    "### Subheading keeps the section",
    "- Another.",
  ].join("\n"));
  assert.equal(note.releasedAt, "2026-01-02");
  assert.deepEqual(note.items.map((item) => item.raw), ["**Lead** (#1). Top level wrapped onto a second line.", "A child about `GET /api/x`.", "Another."]);
  assert.equal(note.items[1].parent, note.items[0]);
  assert.equal(note.items[2].section, "Changed");
});

test("changelog: the word rule keeps API lines and ignores PR numbers, versions and counts", () => {
  for (const line of [
    "`/api/health` reports more",
    "`POST /issues/:id/release` changed",
    "now answers `404`",
    "returns 409 when taken",
    "send `X-Paperclip-Run-Id`",
    "parsed by `createIssueSchema`",
    "a new route",
    "the endpoint moved",
    "the API is stricter",
    "OpenAPI document",
    "the contract widens",
  ]) assert.equal(isApiLine(line), true, line);
  assert.equal(isApiLine("calls getHealth twice", ["getHealth"]), true);
  for (const line of ["Fixed in #404 and #500", "Upgrade to v2026.403.0", "1,404 tests pass", "rapid sidebar", "the router file"]) {
    assert.equal(isApiLine(line), false, line);
  }
});

test("changelog: newest first; withdrawn, upstream and test lines skipped; deprecations kept whole; private lines withheld and counted", () => {
  const privateWord = "MK";
  assert.ok(WITHHELD_LINE_RULES.some((rule) => rule.pattern.test(privateWord)));
  const selection = selectApiChanges([
    NOTE("v1.0.0", "2026-01-01", "## Fixed\n\n- `GET /api/a` answers 404.\n- A UI-only fix."),
    NOTE("v1.1.0", "2026-02-01", `## Changed\n\n- **Shell** for everyone.\n  - \`GET /api/b\` answers 404 now.\n- ${privateWord} companies get a new route.\n\n## Deprecated\n\n- The old field goes away on 2026-04-01.\n\n## Tests\n\n- 12 route tests.`),
    NOTE("v1.0.1", "2026-01-15", "## Fixed\n\n- `GET /api/c`", "> Withdrawn, never released."),
    NOTE("v0.9.0", "2025-12-01", "## Fixed\n\n- `GET /api/d`", "> Upstream: inherited."),
  ]);
  assert.deepEqual(selection.releases.map((release) => release.version), ["v1.1.0", "v1.0.0"]);
  assert.deepEqual(selection.releases[0].kept.map((line) => line.text), ["**Shell:** `GET /api/b` answers 404 now.", "The old field goes away on 2026-04-01."]);
  assert.deepEqual(selection.releases[1].kept.map((line) => line.text), ["`GET /api/a` answers 404."]);
  assert.deepEqual(Object.values(selection.withheld), [1]);
  assert.equal(selection.skippedWithdrawn, 1);
  assert.equal(selection.skippedUpstream, 1);
  const page = renderApiChangelog(selection);
  assert.equal(page, renderApiChangelog(selection), "deterministic");
  assert.match(page, /^## v1\.1\.0 — 2026-02-01$/m);
  assert.match(page, /1 line withheld/);
  assert.doesNotMatch(page, new RegExp(`\\b${privateWord}\\b`));
  assert.doesNotMatch(page, /\/api\/(c|d|ignored)\b/);
});

test("the real repo: the committed changelog is current and carries no withheld word", () => {
  const { markdown, selection } = buildApiChangelog(REPO_ROOT);
  assert.equal(readFileSync(path.join(REPO_ROOT, "docs", "api", "changelog.md"), "utf8"), markdown);
  const body = markdown.split("\n").filter((line) => line.startsWith("- "));
  for (const line of body) assert.equal(withheldReason(line), null, line);
  assert.ok(selection.releases.length > 0);
});

test("changelog: withheld spellings, interface names, numbered items, attribution and old breaking headings", () => {
  for (const text of ["run paperclipai db:backup", "@paperclipai/shared", "PaperclipAI", "fix-paperclip", "MK_PROFILE", "an mk_profile company"]) {
    assert.notEqual(withheldReason(text), null, text);
  }
  for (const text of ["send X-Paperclip-Run-Id", "set PAPERCLIP_PUBLIC_URL", "mkdir -p", "make it so"]) {
    assert.equal(withheldReason(text), null, text);
  }
  assert.ok(WITHHELD_LINE_RULES.length >= 4);
  assert.equal(cleanLine("Fixed (#531, @someone). See (@other) [docs](x.md)"), "Fixed (#531). See docs");
  const note = parseRelease("# v1.0.0\n> Released: 2026-01-02.\n## Upgrade Guide\n1. Confirm `GET /api/health` answers 200.\n2) Then restart.");
  assert.deepEqual(note.items.map((item) => item.raw), ["Confirm `GET /api/health` answers 200.", "Then restart."]);
  const selection = selectApiChanges([
    NOTE("v1.0.0", "2026-01-01", "## Behaviour Changes You Must Read First\n\n- Agents now start paused.\n\n## Testing\n\n- The route suite grew."),
  ]);
  assert.deepEqual(selection.releases[0].kept.map((line) => line.text), ["Agents now start paused."]);
});

test("changelog: a line with an email, an IP address, a private hostname or the engagement's product is withheld and counted", () => {
  const productName = ["Exec", "OS"].join("");
  const selection = selectApiChanges([
    NOTE(
      "v1.0.0",
      "2026-01-01",
      [
        "## Fixed",
        "",
        "- `GET /api/a` now answers 404 (reported by someone@example.com).",
        "- `GET /api/b` was unreachable from 10.1.2.3.",
        "- `GET /api/c` is served on build-box.local too.",
        `- \`POST /api/d\` accepts the ${productName} origin.`,
        "- `GET /api/e` answers 404 on v2026.930.1 and later.",
      ].join("\n"),
    ),
  ]);
  assert.deepEqual(selection.releases[0].kept.map((line) => line.text), ["`GET /api/e` answers 404 on v2026.930.1 and later."]);
  assert.deepEqual(selection.withheld, {
    "carrying an email address": 1,
    "carrying an IP address": 1,
    "carrying a private hostname": 1,
    "engagement-specific": 1,
  });
  // The hashed list is consulted too, so a name in it is withheld without being spelled out here.
  assert.ok(WITHHELD_LINE_RULES.some((rule) => /hashed list/.test(rule.reason)));
});
