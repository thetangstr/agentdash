#!/usr/bin/env node
// Ask Vercel to rebuild www.agentdash.cloud once a stable GitHub Release is
// published, so /releases lists the new version (the build reads the
// published list through scripts/published-releases.mjs).
//
//   VERCEL_DEPLOY_HOOK_URL=<hook> node scripts/release-site-deploy.mjs [--expect-version vYYYY.MDD.P]
//
// The hook URL is a credential: anyone holding it can start production
// builds. It is read from the environment only, never taken as an argument
// and never printed, not even in an error. release.yml passes it from the
// repository secret of the same name.
//
// Unset: prints a warning and exits 0. The site then picks the release up on
// the next merge to main.
// Set: POSTs to it, retrying a network error or a 5xx up to twice, and prints
// only the HTTP status. Exits 1 when Vercel does not accept the request; the
// GitHub Release is already published by then, so rerunning this step is
// safe.
//
// --expect-version: after the hook is accepted, polls the list the site build
// publishes (https://www.agentdash.cloud/releases/published.json, written by
// scripts/published-releases.mjs) for up to 15 minutes, with a growing pause,
// until it lists that version. If it never does, exits 1: either the build
// fell back to the committed snapshot (the GitHub Releases API was unreachable
// or rate-limited) or the deploy did not finish. A stale site is then a red
// job, not a silent lag.

import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HOOK_ENV = "VERCEL_DEPLOY_HOOK_URL";
export const SITE_PUBLISHED_URL = "https://www.agentdash.cloud/releases/published.json";
const ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;
const POLL_DEADLINE_MS = 15 * 60_000;
const POLL_FIRST_PAUSE_MS = 15_000;
const POLL_MAX_PAUSE_MS = 120_000;
const STABLE_TAG = /^v\d{4}\.\d{3,4}\.\d+$/;

/** { source, versions } from the site's public list, or null when the body is not one. */
export function readSiteList(body) {
  if (!body || typeof body !== "object" || body.schema !== 1 || !Array.isArray(body.published)) return null;
  if (body.source !== "api" && body.source !== "snapshot") return null;
  const versions = [];
  for (const entry of body.published) {
    if (!entry || typeof entry !== "object" || typeof entry.version !== "string" || !STABLE_TAG.test(entry.version)) return null;
    versions.push(entry.version);
  }
  return { source: body.source, versions };
}

/**
 * Polls the site's public list until it names `version`.
 * @returns {Promise<{ outcome: "listed" | "stale", source?: string, last?: string }>}
 */
export async function waitForSiteVersion({
  version,
  url = SITE_PUBLISHED_URL,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  deadlineMs = POLL_DEADLINE_MS,
  log = console.log,
  error = console.error,
  actions = false,
} = {}) {
  const start = now();
  let pause = POLL_FIRST_PAUSE_MS;
  let last = "no answer";
  let lastSource = null;
  for (let poll = 1; ; poll += 1) {
    try {
      // A fresh query string per poll, so no cache can answer with an old list.
      const response = await fetchImpl(`${url}?expect=${encodeURIComponent(version)}&poll=${poll}`, {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        last = `HTTP ${response.status}`;
      } else {
        let body;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        const list = readSiteList(body);
        if (!list) {
          last = "a body that is not the published list";
        } else if (list.versions.includes(version)) {
          log(`www.agentdash.cloud lists ${version} (published list from source "${list.source}", poll ${poll}).`);
          return { outcome: "listed", source: list.source };
        } else {
          lastSource = list.source;
          last = `a list from source "${list.source}" with ${list.versions.length} versions, without ${version}`;
        }
      }
    } catch (err) {
      last = `network error (${err?.cause?.code ?? err?.name ?? "error"})`;
    }
    if (now() - start + pause > deadlineMs) break;
    log(`www.agentdash.cloud does not list ${version} yet (${last}); checking again in ${Math.round(pause / 1000)} s.`);
    await sleep(pause);
    pause = Math.min(pause * 2, POLL_MAX_PAUSE_MS);
  }
  const minutes = Math.round(deadlineMs / 60_000);
  const cause = lastSource === "snapshot"
    ? "The site build fell back to the committed snapshot releases/published.json because it could not read the GitHub Releases API"
    : "Either the site build fell back to the committed snapshot (the GitHub Releases API was unreachable or rate-limited) or the deploy did not finish";
  error(
    `${actions ? "::error::" : ""}${url} still does not list ${version} after ${minutes} minutes (last answer: ${last}). ` +
      `${cause}. The GitHub Release is published. Rerun this job once the deploy has finished, ` +
      "or set a read-only GITHUB_TOKEN in Vercel's Production environment so the build can read the API.",
  );
  return { outcome: "stale", last };
}

/**
 * @returns {Promise<{ outcome: "skipped" | "triggered" | "failed", status?: number }>}
 */
export async function triggerSiteDeploy({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
  warn = console.warn,
  error = console.error,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = TIMEOUT_MS,
  expectVersion,
  siteUrl,
  now,
  deadlineMs,
} = {}) {
  const actions = env.GITHUB_ACTIONS === "true";
  const hook = env[HOOK_ENV]?.trim();
  if (!hook) {
    warn(
      `${actions ? "::warning::" : ""}${HOOK_ENV} is not set, so www.agentdash.cloud was not asked to rebuild. ` +
        "The new release appears on /releases after the next merge to main.",
    );
    return { outcome: "skipped" };
  }
  let url;
  try {
    url = new URL(hook);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:") {
    error(`${actions ? "::error::" : ""}${HOOK_ENV} is set but is not an https URL; nothing was sent.`);
    return { outcome: "failed" };
  }

  let last = "no attempt";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let status;
    try {
      const response = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(timeoutMs) });
      status = response.status;
    } catch (err) {
      // Name the failure only: messages and causes can quote the URL.
      last = `network error (${err?.cause?.code ?? err?.name ?? "error"})`;
    }
    if (status !== undefined) {
      if (status >= 200 && status < 300) {
        log(`Asked Vercel to rebuild www.agentdash.cloud (HTTP ${status}).`);
        if (!expectVersion) return { outcome: "triggered", status };
        const site = await waitForSiteVersion({ version: expectVersion, url: siteUrl, fetchImpl, sleep, now, deadlineMs, log, error, actions });
        return site.outcome === "listed" ? { outcome: "triggered", status, listed: true } : { outcome: "failed", status, stale: true };
      }
      last = `HTTP ${status}`;
      if (status < 500) break;
    }
    if (attempt < ATTEMPTS) await sleep(attempt * 2000);
  }
  error(
    `${actions ? "::error::" : ""}The Vercel deploy hook did not accept the request (${last}). ` +
      "The GitHub Release is published; rerun this step, or the site updates on the next merge to main.",
  );
  return { outcome: "failed" };
}

// Entry guard: resolve symlinks on both sides (scripts/entry-guard.test.mjs; cf. #666).
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
if (process.argv[1] && realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const usage = `Usage: ${HOOK_ENV}=<hook> node scripts/release-site-deploy.mjs [--expect-version vYYYY.MDD.P] (the hook is read from the environment only)`;
  let expectVersion;
  let valid = true;
  if (argv.length === 2 && argv[0] === "--expect-version" && STABLE_TAG.test(argv[1])) expectVersion = argv[1];
  else if (argv.length !== 0) valid = false;
  if (!valid) {
    // Never echo the arguments: a mistaken invocation may carry the hook.
    console.error(usage);
    process.exitCode = 2;
  } else {
    const { outcome } = await triggerSiteDeploy({ expectVersion });
    process.exitCode = outcome === "failed" ? 1 : 0;
  }
}
