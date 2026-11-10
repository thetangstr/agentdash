// scripts/release-site-deploy.mjs: the Vercel deploy hook after a stable
// release. fetch is always mocked; no test reaches Vercel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HOOK_ENV, SITE_PUBLISHED_URL, readSiteList, triggerSiteDeploy, waitForSiteVersion } from "./release-site-deploy.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-site-deploy.mjs");
const HOOK = "https://api.vercel.com/v1/integrations/deploy/prj_hookproject/secret-hook-token";

function harness(responses, env = { [HOOK_ENV]: HOOK, GITHUB_ACTIONS: "true" }) {
  const lines = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    const next = responses[calls.length - 1];
    if (next instanceof Error) throw next;
    return { status: next };
  };
  const run = () =>
    triggerSiteDeploy({
      env,
      fetchImpl,
      log: (l) => lines.push(l),
      warn: (l) => lines.push(l),
      error: (l) => lines.push(l),
      sleep: async () => {},
    });
  return { run, lines, calls };
}

function assertNoHook(lines) {
  const text = lines.join("\n");
  assert.doesNotMatch(text, /secret-hook-token|prj_hookproject|api\.vercel\.com/, "the hook URL must never be printed");
}

test("unset: warns and continues without calling anything", async () => {
  for (const env of [{ GITHUB_ACTIONS: "true" }, { [HOOK_ENV]: "   ", GITHUB_ACTIONS: "true" }]) {
    const h = harness([], env);
    assert.deepEqual(await h.run(), { outcome: "skipped" });
    assert.equal(h.calls.length, 0);
    assert.match(h.lines.join("\n"), /^::warning::VERCEL_DEPLOY_HOOK_URL is not set/);
  }
});

test("set: POSTs once and prints only the status", async () => {
  const h = harness([201]);
  assert.deepEqual(await h.run(), { outcome: "triggered", status: 201 });
  assert.deepEqual(h.calls, [{ url: HOOK, method: "POST" }]);
  assert.match(h.lines.join("\n"), /Asked Vercel to rebuild www\.agentdash\.cloud \(HTTP 201\)/);
  assertNoHook(h.lines);
});

test("retries network errors and 5xx, then fails without printing the hook", async () => {
  const flaky = harness([Object.assign(new TypeError(`fetch failed for ${HOOK}`), { cause: { code: "ECONNRESET", message: HOOK } }), 503, 200]);
  assert.equal((await flaky.run()).outcome, "triggered");
  assert.equal(flaky.calls.length, 3);
  assertNoHook(flaky.lines);

  const down = harness([502, new TypeError(`fetch failed for ${HOOK}`), 500]);
  assert.deepEqual(await down.run(), { outcome: "failed" });
  assert.equal(down.calls.length, 3);
  assert.match(down.lines.join("\n"), /::error::The Vercel deploy hook did not accept the request \(HTTP 500\)/);
  assertNoHook(down.lines);
});

test("a 4xx is not retried", async () => {
  const h = harness([404]);
  assert.deepEqual(await h.run(), { outcome: "failed" });
  assert.equal(h.calls.length, 1);
  assert.match(h.lines.join("\n"), /HTTP 404/);
  assertNoHook(h.lines);
});

test("a value that is not an https URL is refused without echoing it", async () => {
  for (const value of ["http://api.vercel.com/v1/integrations/deploy/prj_hookproject/secret-hook-token", "secret-hook-token"]) {
    const h = harness([200], { [HOOK_ENV]: value });
    assert.deepEqual(await h.run(), { outcome: "failed" });
    assert.equal(h.calls.length, 0);
    assertNoHook(h.lines);
  }
});

test("the CLI never takes the hook as an argument, and with the secret unset warns and passes", () => {
  for (const args of [[HOOK], ["--expect-version", HOOK], ["--expect-version", "latest"], ["--expect-version"], ["--expect-version", "v2026.1109.0", HOOK]]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(result.status, 2, args.join(" "));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-hook-token/);
  }
  for (const args of [[], ["--expect-version", "v2026.1109.0"]]) {
    const unset = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(unset.status, 0, unset.stderr);
    assert.match(unset.stderr, /VERCEL_DEPLOY_HOOK_URL is not set/);
  }
});

// The site's public list (scripts/published-releases.mjs writes it).
const siteList = (source, versions) => ({ schema: 1, source, published: versions.map((version) => ({ version, publishedAt: null })) });
const jsonAnswer = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A fake clock that advances when the code sleeps, and a fetch serving the hook and then each poll. */
function siteHarness(polls, hookStatus = 200) {
  let t = 0;
  const sleeps = [];
  const lines = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if (init?.method === "POST") return { status: hookStatus };
    const next = polls[Math.min(calls.filter((c) => c.method === "GET").length - 1, polls.length - 1)];
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : jsonAnswer(next);
  };
  const run = (version = "v2026.1109.0") =>
    triggerSiteDeploy({
      env: { [HOOK_ENV]: HOOK, GITHUB_ACTIONS: "true" },
      fetchImpl,
      expectVersion: version,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      log: (l) => lines.push(l),
      warn: (l) => lines.push(l),
      error: (l) => lines.push(l),
    });
  return { run, sleeps, lines, calls };
}

test("after the hook, waits until the site lists the new version", async () => {
  const h = siteHarness([siteList("api", ["v2026.1105.0"]), () => jsonAnswer({}, 404), siteList("api", ["v2026.1109.0", "v2026.1105.0"])]);
  assert.deepEqual(await h.run(), { outcome: "triggered", status: 200, listed: true });
  assert.deepEqual(h.sleeps, [15_000, 30_000]);
  const polls = h.calls.filter((c) => c.method === "GET");
  assert.equal(polls.length, 3);
  assert.ok(polls.every((c) => c.url.startsWith(`${SITE_PUBLISHED_URL}?expect=v2026.1109.0&poll=`)), "a fresh query string per poll");
  assert.match(h.lines.join("\n"), /www\.agentdash\.cloud lists v2026\.1109\.0 \(published list from source "api", poll 3\)/);
  assertNoHook(h.lines);
});

test("a site that fell back to the snapshot fails the job after about 15 minutes, saying why", async () => {
  const h = siteHarness([siteList("snapshot", ["v2026.1105.0"])]);
  assert.deepEqual(await h.run(), { outcome: "failed", status: 200, stale: true });
  assert.deepEqual(h.sleeps, [15_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000, 120_000, 120_000]);
  assert.ok(h.sleeps.reduce((a, b) => a + b, 0) <= 15 * 60_000);
  assert.equal(h.calls.filter((c) => c.method === "GET").length, 10);
  const text = h.lines.join("\n");
  assert.match(text, /::error::https:\/\/www\.agentdash\.cloud\/releases\/published\.json still does not list v2026\.1109\.0 after 15 minutes/);
  assert.match(text, /fell back to the committed snapshot releases\/published\.json/);
  assert.match(text, /Rerun this job once the deploy has finished, or set a read-only GITHUB_TOKEN in Vercel's Production environment/);
  assertNoHook(h.lines);
});

test("a deploy that never answers fails with both possible causes named", async () => {
  const h = siteHarness([Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), () => jsonAnswer(null, 503), { not: "the list" }]);
  assert.equal((await h.run()).outcome, "failed");
  const text = h.lines.join("\n");
  assert.match(text, /last answer: a body that is not the published list/);
  assert.match(text, /Either the site build fell back to the committed snapshot .* or the deploy did not finish/);
  assertNoHook(h.lines);
});

test("without --expect-version the hook is fire-and-forget; a refused hook never polls", async () => {
  const plain = harness([200]);
  assert.deepEqual(await plain.run(), { outcome: "triggered", status: 200 });
  assert.equal(plain.calls.length, 1);
  const refused = siteHarness([siteList("api", ["v2026.1109.0"])], 404);
  assert.deepEqual(await refused.run(), { outcome: "failed" });
  assert.equal(refused.calls.filter((c) => c.method === "GET").length, 0);
});

test("reads only the public list's shape", async () => {
  assert.deepEqual(readSiteList(siteList("api", ["v2026.1109.0"])), { source: "api", versions: ["v2026.1109.0"] });
  for (const bad of [null, [], { schema: 2, source: "api", published: [] }, { schema: 1, source: "github-feed", published: [] }, { schema: 1, source: "api", published: [{ version: "latest" }] }]) {
    assert.equal(readSiteList(bad), null, JSON.stringify(bad));
  }
  const listed = await waitForSiteVersion({ version: "v2026.1109.0", fetchImpl: async () => jsonAnswer(siteList("snapshot", ["v2026.1109.0"])), log: () => {}, error: () => {} });
  assert.deepEqual(listed, { outcome: "listed", source: "snapshot" });
});
