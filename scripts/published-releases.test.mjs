// scripts/published-releases.mjs: the published list behind the public
// /releases pages. The GitHub Releases API is always mocked; no test reaches
// the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENERATED_REL,
  PUBLIC_REL,
  SNAPSHOT_REL,
  fetchPublishedVersions,
  main,
  parsePublishedFile,
  readPublishedFile,
  renderPublishedFile,
  resolvePublishedVersions,
  sortVersions,
  stableVersionsFromPage,
  WITHDRAWN_LINE,
} from "./published-releases.mjs";
import { WITHDRAWN_LINE as NOTES_WITHDRAWN_LINE } from "./docs/generate-api-changelog.mjs";

// Fixtures only: no test reads the repository's own releases/ or snapshot,
// which change with every release (the CI step checks those).
const SCRIPT_SOURCE = fileURLToPath(new URL("./published-releases.mjs", import.meta.url));
const release = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...extra });

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * A fetch that serves API responses in order and records every request. Each
 * item is a page (an array or object, served as JSON), a response factory or
 * an Error. Any request that is not the Releases API fails the test.
 */
function fakeFetch(pages) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    assert.match(url, /^https:\/\/api\.github\.com\/repos\//, "only the Releases API is ever read");
    const item = pages[calls.length - 1] ?? [];
    if (item instanceof Error) throw item;
    if (typeof item === "function") return item();
    return jsonResponse(item);
  };
  return { impl, calls };
}

const noSleep = { sleeps: [], sleep: async (ms) => noSleep.sleeps.push(ms) };
const instant = () => {
  const sleeps = [];
  return { sleeps, sleep: async (ms) => sleeps.push(ms) };
};

function fixtureRoot(snapshot) {
  const root = mkdtempSync(path.join(tmpdir(), "published-releases-"));
  mkdirSync(path.join(root, "releases"));
  mkdirSync(path.join(root, path.dirname(GENERATED_REL)), { recursive: true });
  if (snapshot !== undefined) writeFileSync(path.join(root, SNAPSHOT_REL), typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot));
  return root;
}

function quiet() {
  const lines = [];
  return { lines, log: (line) => lines.push(line), warn: (line) => lines.push(line) };
}

test("keeps only published stable releases, newest first", () => {
  assert.deepEqual(
    stableVersionsFromPage([
      release("v2026.1104.0"),
      release("v2026.1105.0"),
      release("v2026.1106.0", { draft: true }),
      release("v2026.1106.1", { prerelease: true }),
      release("canary/v2026.1106.0-canary.0"),
      release("agentdash-connect-v0.5.0"),
      release("v2026.928.0", { draft: undefined }),
    ]),
    ["v2026.1104.0", "v2026.1105.0"],
  );
  assert.deepEqual(sortVersions(["v2026.930.1", "v2026.1001.0", "v2026.930.0", "v2026.1001.0"]), ["v2026.1001.0", "v2026.930.1", "v2026.930.0"]);
  assert.throws(() => stableVersionsFromPage({ message: "Not Found" }), /did not return a list/);
  assert.throws(() => stableVersionsFromPage([{ name: "no tag" }]), /without a tag_name/);
});

test("the public list and the notes check use the same withdrawn marker", () => {
  assert.equal(WITHDRAWN_LINE.source, NOTES_WITHDRAWN_LINE.source);
  assert.equal(WITHDRAWN_LINE.flags, NOTES_WITHDRAWN_LINE.flags);
});

test("a release withdrawn after publication is left off the public list; its replacement is listed", () => {
  const withdrawn = "> **Withdrawn on 2026-11-09. Do not install this release.** It is superseded.\n\n# v2026.1109.0\n";
  assert.deepEqual(
    stableVersionsFromPage([
      release("v2026.1109.1", { body: "# v2026.1109.1\n\n> Released: 2026-11-09.\n\nThis release replaces v2026.1109.0, which was withdrawn.\n" }),
      release("v2026.1109.0", { body: withdrawn }),
      release("v2026.1105.0", { body: null }),
    ]),
    ["v2026.1109.1", "v2026.1105.0"],
  );
});

test("reads every page of the Releases API and sends GITHUB_TOKEN when given", async () => {
  const first = Array.from({ length: 100 }, (_, i) => release(i === 0 ? "v2026.1105.0" : `pkg-v0.0.${i}`));
  const { impl, calls } = fakeFetch([first, [release("v2026.827.0")]]);
  const versions = await fetchPublishedVersions({ repo: "thetangstr/agentdash", token: "test-token", fetchImpl: impl });
  assert.deepEqual(versions, ["v2026.1105.0", "v2026.827.0"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.github.com/repos/thetangstr/agentdash/releases?per_page=100&page=1");
  assert.equal(calls[1].url, "https://api.github.com/repos/thetangstr/agentdash/releases?per_page=100&page=2");
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github+json");

  const anonymous = fakeFetch([[release("v2026.1105.0")]]);
  await fetchPublishedVersions({ fetchImpl: anonymous.impl });
  assert.equal(anonymous.calls[0].init.headers.Authorization, undefined);
});

test("any API failure is an error, never a partial list", async () => {
  const full = Array.from({ length: 100 }, () => release("v2026.1105.0"));
  const down = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
  const limited = () => jsonResponse({ message: "API rate limit exceeded" }, 403);
  const cases = [
    [[down, down, down], /could not be reached \(ENOTFOUND\) \(after 3 attempts\)/, 3],
    [[limited, limited, limited], /HTTP 403 \(after 3 attempts\)/, 3],
    [[() => jsonResponse({}, 429), () => jsonResponse({}, 429), () => jsonResponse({}, 429)], /HTTP 429 \(after 3 attempts\)/, 3],
    [[full, () => jsonResponse({}, 502), () => jsonResponse({}, 503), () => jsonResponse({}, 500)], /HTTP 500 \(after 3 attempts\)/, 4],
    // Not retried: a 404 or 401 will not change, and neither will a malformed body.
    [[() => jsonResponse({ message: "Not Found" }, 404)], /HTTP 404$/, 1],
    [[() => jsonResponse({ message: "Bad credentials" }, 401)], /HTTP 401$/, 1],
    [[() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } })], /not JSON/, 1],
    [[{ message: "Moved" }], /did not return a list/, 1],
  ];
  for (const [pages, pattern, calls] of cases) {
    const fake = fakeFetch(pages);
    await assert.rejects(fetchPublishedVersions({ fetchImpl: fake.impl, sleep: noSleep.sleep }), pattern);
    assert.equal(fake.calls.length, calls, String(pattern));
  }
  await assert.rejects(fetchPublishedVersions({ fetchImpl: fakeFetch([full, full]).impl, maxPages: 2 }), /more than 2 pages/);
  await assert.rejects(fetchPublishedVersions({ repo: "not a repo", fetchImpl: fakeFetch([[]]).impl }), /owner\/name/);
});

test("retries network errors, 5xx, 403 and 429 with a growing pause, then succeeds", async () => {
  const pause = instant();
  const fake = fakeFetch([
    Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }),
    () => jsonResponse({ message: "secondary rate limit" }, 403),
    [release("v2026.1105.0")],
  ]);
  assert.deepEqual(await fetchPublishedVersions({ fetchImpl: fake.impl, sleep: pause.sleep }), ["v2026.1105.0"]);
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(pause.sleeps, [2000, 4000]);
  const retried429 = fakeFetch([() => jsonResponse({}, 429), () => jsonResponse({}, 502), [release("v2026.1104.0")]]);
  assert.deepEqual(await fetchPublishedVersions({ fetchImpl: retried429.impl, sleep: noSleep.sleep }), ["v2026.1104.0"]);
});

test("validates a published-list file", () => {
  assert.deepEqual(parsePublishedFile({ schema: 1, published: ["v2026.1105.0"] }), ["v2026.1105.0"]);
  assert.throws(() => parsePublishedFile([]), /not a JSON object/);
  assert.throws(() => parsePublishedFile({ schema: 2, published: [] }), /schema is not 1/);
  assert.throws(() => parsePublishedFile({ schema: 1 }), /no "published" list/);
  assert.throws(() => parsePublishedFile({ schema: 1, published: ["v2026.1105.0", "latest", "v0.3.1-beta"] }), /2 entries that are not/);
  assert.equal(renderPublishedFile(["v2026.827.0", "v2026.1105.0"], "github-api"), '{\n  "schema": 1,\n  "source": "github-api",\n  "published": [\n    "v2026.1105.0",\n    "v2026.827.0"\n  ]\n}\n');
});

test("API ok: the generated list is the API's, not the snapshot's", async () => {
  const root = fixtureRoot({ schema: 1, published: ["v2026.1104.0"] });
  try {
    const { impl, calls } = fakeFetch([[
      release("v2026.1105.0", { published_at: "2026-11-05T18:02:11Z", body: "full notes", author: { login: "someone" } }),
      release("v2026.1104.0", { published_at: "not a date" }),
    ]]);
    const out = quiet();
    assert.equal(await main([], { env: {}, fetchImpl: impl, repoRoot: root, ...out }), 0);
    const generated = JSON.parse(readFileSync(path.join(root, GENERATED_REL), "utf8"));
    assert.deepEqual(generated, { schema: 1, source: "github-api", published: ["v2026.1105.0", "v2026.1104.0"] });
    // The public copy carries versions, publishedAt and the source label, nothing else.
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, PUBLIC_REL), "utf8")), {
      schema: 1,
      source: "api",
      published: [
        { version: "v2026.1105.0", publishedAt: "2026-11-05T18:02:11Z" },
        { version: "v2026.1104.0", publishedAt: null },
      ],
    });
    assert.match(out.lines.join("\n"), /2 published stable releases from the GitHub Releases API \(thetangstr\/agentdash, unauthenticated\)/);
    assert.equal(calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("API rate-limited on every attempt: the snapshot, with a warning that new versions may be missing", async () => {
  const root = fixtureRoot({ schema: 1, published: ["v2026.1104.0", "v2026.1105.0"] });
  try {
    const limited = () => jsonResponse({ message: "API rate limit exceeded" }, 403);
    const { impl, calls } = fakeFetch([limited, limited, limited]);
    const out = quiet();
    const pause = instant();
    assert.equal(await main([], { env: { GITHUB_TOKEN: "secret-token-value", GITHUB_ACTIONS: "true" }, fetchImpl: impl, repoRoot: root, sleep: pause.sleep, ...out }), 0);
    assert.equal(calls.length, 3);
    assert.deepEqual(pause.sleeps, [2000, 4000]);
    const generated = JSON.parse(readFileSync(path.join(root, GENERATED_REL), "utf8"));
    assert.deepEqual(generated, { schema: 1, source: "snapshot", published: ["v2026.1105.0", "v2026.1104.0"] });
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, PUBLIC_REL), "utf8")), {
      schema: 1,
      source: "snapshot",
      published: [{ version: "v2026.1105.0", publishedAt: null }, { version: "v2026.1104.0", publishedAt: null }],
    });
    const text = out.lines.join("\n");
    assert.match(text, /::warning::published-releases: using releases\/published\.json because the Releases API answered HTTP 403 \(after 3 attempts\)\. Versions published since the last snapshot refresh may be missing/);
    assert.doesNotMatch(text, /secret-token-value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("API failure that is not retried: straight to the snapshot", async () => {
  const root = fixtureRoot({ schema: 1, published: ["v2026.1105.0"] });
  try {
    const { impl, calls } = fakeFetch([() => jsonResponse({ message: "Bad credentials" }, 401)]);
    const out = quiet();
    assert.equal(await main([], { env: { GITHUB_TOKEN: "secret-token-value" }, fetchImpl: impl, repoRoot: root, sleep: noSleep.sleep, ...out }), 0);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(readFileSync(path.join(root, GENERATED_REL), "utf8")).source, "snapshot");
    assert.match(out.lines.join("\n"), /because the Releases API answered HTTP 401\. Versions published since/);
    assert.doesNotMatch(out.lines.join("\n"), /secret-token-value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline mode never calls the API", async () => {
  const root = fixtureRoot({ schema: 1, published: ["v2026.1105.0"] });
  try {
    const { impl, calls } = fakeFetch([]);
    assert.equal(await main(["--offline"], { env: {}, fetchImpl: impl, repoRoot: root, ...quiet() }), 0);
    assert.equal(calls.length, 0);
    assert.equal(JSON.parse(readFileSync(path.join(root, GENERATED_REL), "utf8")).source, "snapshot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken snapshot with an unreachable API fails the build instead of publishing a partial list", async () => {
  for (const snapshot of [undefined, "{not json", { schema: 1, published: ["main"] }]) {
    const root = fixtureRoot(snapshot);
    try {
      const out = quiet();
      const { impl } = fakeFetch([new Error("offline"), new Error("offline"), new Error("offline")]);
      assert.equal(await main([], { env: {}, fetchImpl: impl, repoRoot: root, sleep: noSleep.sleep, ...out }), 1);
      assert.match(out.lines.join("\n"), /releases\/published\.json cannot be used/);
      await assert.rejects(resolvePublishedVersions({ repoRoot: root, offline: true }), /cannot be used/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("--update-snapshot writes only API versions that have a released notes file, and never falls back", async () => {
  const root = fixtureRoot({ schema: 1, published: ["v2026.1104.0"] });
  try {
    writeFileSync(path.join(root, "releases/v2026.1105.0.md"), "# v2026.1105.0\n\n> Released: 2026-11-05\n");
    writeFileSync(path.join(root, "releases/v2026.1104.0.md"), "# v2026.1104.0\n\n> Released: 2026-11-04\n");
    writeFileSync(path.join(root, "releases/v2026.902.1.md"), "# v2026.902.1\n\n> Withdrawn, never released.\n");
    const { impl } = fakeFetch([[release("v2026.1105.0"), release("v2026.1104.0"), release("v2026.902.1"), release("v2026.1106.0")]]);
    const out = quiet();
    assert.equal(await main(["--update-snapshot"], { env: {}, fetchImpl: impl, repoRoot: root, ...out }), 0);
    assert.deepEqual(readPublishedFile(path.join(root, SNAPSHOT_REL)), ["v2026.1105.0", "v2026.1104.0"]);
    assert.match(out.lines.join("\n"), /left out v2026\.1106\.0 \(no releases\/v2026\.1106\.0\.md\)/);
    assert.match(out.lines.join("\n"), /left out v2026\.902\.1 \(withdrawn or upstream note\)/);

    const before = readFileSync(path.join(root, SNAPSHOT_REL), "utf8");
    assert.equal(await main(["--update-snapshot"], { env: {}, fetchImpl: fakeFetch([new Error("offline"), new Error("offline"), new Error("offline")]).impl, repoRoot: root, sleep: noSleep.sleep, ...quiet() }), 1);
    assert.equal(readFileSync(path.join(root, SNAPSHOT_REL), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI's --offline path writes both lists from the snapshot without touching the network", () => {
  // A copy of the script in a fixture tree: it resolves releases/ from its own location.
  const root = fixtureRoot({ schema: 1, published: ["v2026.1104.0", "v2026.1105.0"] });
  try {
    mkdirSync(path.join(root, "scripts"));
    const script = path.join(root, "scripts/published-releases.mjs");
    writeFileSync(script, readFileSync(SCRIPT_SOURCE));
    // An unroutable proxy: --offline must not need the network at all.
    const env = { PATH: "/usr/bin:/bin", GITHUB_TOKEN: "secret-token-value", HTTPS_PROXY: "http://127.0.0.1:9" };
    const result = spawnSync(process.execPath, [script, "--offline"], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /using releases\/published\.json because offline mode\. Versions published since the last snapshot refresh may be missing/);
    assert.equal(result.stdout, `Wrote ${GENERATED_REL} and ${PUBLIC_REL}: 2 published stable releases from releases/published.json.\n`);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, GENERATED_REL), "utf8")), { schema: 1, source: "snapshot", published: ["v2026.1105.0", "v2026.1104.0"] });
    assert.equal(JSON.parse(readFileSync(path.join(root, PUBLIC_REL), "utf8")).source, "snapshot");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-token-value/);
    const bad = spawnSync(process.execPath, [script, "--nope"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(bad.status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
