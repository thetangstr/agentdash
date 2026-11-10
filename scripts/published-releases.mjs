#!/usr/bin/env node
// Which stable versions have a published GitHub Release, for the public
// release-notes pages at www.agentdash.cloud/releases.
//
// A version is listed on the site only after its stable GitHub Release is
// published (not a draft, not a prerelease). Vercel runs this before the UI
// build (vercel.json `buildCommand`):
//
//   node scripts/published-releases.mjs                    # write the generated list
//   node scripts/published-releases.mjs --offline          # snapshot only, no network
//   node scripts/published-releases.mjs --update-snapshot  # release prep: refresh releases/published.json
//
// It writes ui/src/marketing/content/published-releases.generated.json
// (gitignored) from, in order:
//
//   1. the Releases API, every page of
//      https://api.github.com/repos/<repo>/releases, with GITHUB_TOKEN from
//      the environment when set (unauthenticated calls are limited to 60 an
//      hour per address, and build machines share addresses). Drafts and
//      prereleases are skipped. Each request is tried up to 3 times, with a
//      growing pause, on a network error, a 5xx, a 403 or a 429.
//   2. the committed snapshot releases/published.json, when the API cannot be
//      read. The log then warns that versions published since the last
//      snapshot refresh may be missing.
//
// It also writes the same list, as { schema, source: "api" | "snapshot",
// published: [{ version, publishedAt }] } and nothing else, to
// ui/public/releases/published.json (gitignored), which the site serves at
// https://www.agentdash.cloud/releases/published.json. release.yml's
// refresh_release_site polls it after the deploy hook, so a site that fell
// back to the snapshot, or a deploy that never finished, fails that job
// instead of going unnoticed. publishedAt is the API's published_at, or null
// for versions taken from the snapshot.
//
// The public releases.atom feed is deliberately not a source: it can list
// plain tags that have no published GitHub Release. A missing or invalid
// snapshot fails the run whenever the API failed. The pages intersect this
// list with the bundled notes (ui/src/marketing/content/releases.ts), so a
// version appears only when one of these sources has it and its notes file is
// neither withdrawn nor inherited from upstream.
//
// The snapshot is refreshed by each release-prep PR with --update-snapshot,
// which never falls back: it fails when the API cannot be read.
// scripts/ci/check-release-log.mjs checks every snapshot entry against the
// notes and the stable tags on origin.
//
// Node builtins only. The token is never printed.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The marker of a release withdrawn after publication. This module runs alone in the
// site build (and is copied alone by its own test), so it carries its own copy of the
// marker; scripts/published-releases.test.mjs fails if it drifts from
// WITHDRAWN_LINE in scripts/docs/generate-api-changelog.mjs.
export const WITHDRAWN_LINE = /^>\s*(?:\*\*)?Withdrawn(?:, never released|\s+on\s+\d{4}-\d{2}-\d{2})/i;

export const DEFAULT_REPO = "thetangstr/agentdash";
export const SNAPSHOT_REL = "releases/published.json";
export const GENERATED_REL = "ui/src/marketing/content/published-releases.generated.json";
export const PUBLIC_REL = "ui/public/releases/published.json";
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
export const SCHEMA = 1;
const STABLE_TAG = /^v(\d{4})\.(\d{3,4})\.(\d+)$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PER_PAGE = 100;
const MAX_PAGES = 20;
const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;
const RETRY_STATUSES = new Set([403, 429]);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function versionKey(version) {
  const match = STABLE_TAG.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Newest first, duplicates removed. */
export function sortVersions(versions) {
  return [...new Set(versions)].sort((a, b) => {
    const ka = versionKey(a);
    const kb = versionKey(b);
    for (let i = 0; i < 3; i += 1) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  });
}

export function isStableVersion(value) {
  return typeof value === "string" && STABLE_TAG.test(value);
}

/**
 * The stable versions in one page of the Releases API, or an error when the
 * page is not what the API returns. Drafts and prereleases are skipped, and so
 * is any tag that is not `vYYYY.MDD.P` (package releases such as
 * agentdash-connect carry their own tags).
 */
export function stableReleasesFromPage(page) {
  if (!Array.isArray(page)) throw new Error("the Releases API did not return a list");
  const releases = [];
  for (const release of page) {
    if (!release || typeof release !== "object" || typeof release.tag_name !== "string") {
      throw new Error("the Releases API returned an entry without a tag_name");
    }
    if (release.draft !== false || release.prerelease !== false) continue;
    if (!isStableVersion(release.tag_name)) continue;
    // A release withdrawn after publication keeps its tag and page on GitHub but is
    // not listed on the public site.
    if (typeof release.body === "string" && release.body.split(/\r?\n/).some((line) => WITHDRAWN_LINE.test(line))) continue;
    const publishedAt = typeof release.published_at === "string" && ISO_INSTANT.test(release.published_at) ? release.published_at : null;
    releases.push({ version: release.tag_name, publishedAt });
  }
  return releases;
}

export function stableVersionsFromPage(page) {
  return stableReleasesFromPage(page).map((release) => release.version);
}

/** Newest first, one entry per version (the first seen wins). */
export function sortReleases(releases) {
  const byVersion = new Map();
  for (const release of releases) if (!byVersion.has(release.version)) byVersion.set(release.version, release);
  return sortVersions([...byVersion.keys()]).map((version) => byVersion.get(version));
}

/**
 * Every published stable version, newest first. Throws on any failure; the
 * caller decides whether to fall back.
 */
export async function fetchPublishedVersions(options = {}) {
  return (await fetchPublishedReleases(options)).map((release) => release.version);
}

/** Every published stable release as { version, publishedAt }, newest first. Throws on any failure. */
export async function fetchPublishedReleases({
  repo = DEFAULT_REPO,
  token,
  fetchImpl = globalThis.fetch,
  maxPages = MAX_PAGES,
  timeoutMs = TIMEOUT_MS,
  attempts = ATTEMPTS,
  sleep = defaultSleep,
} = {}) {
  if (!REPO_RE.test(repo)) throw new Error("the repository must look like owner/name");
  if (typeof fetchImpl !== "function") throw new Error("this Node has no fetch");
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agentdash-published-releases",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const releases = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `https://api.github.com/repos/${repo}/releases?per_page=${PER_PAGE}&page=${page}`;
    let response;
    for (let attempt = 1; ; attempt += 1) {
      let failure;
      try {
        response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) failure = `the Releases API answered HTTP ${response.status}`;
      } catch (error) {
        response = null;
        failure = `the Releases API could not be reached (${error?.cause?.code ?? error?.name ?? "error"})`;
      }
      if (!failure) break;
      const retryable = !response || response.status >= 500 || RETRY_STATUSES.has(response.status);
      if (!retryable || attempt >= attempts) throw new Error(attempt > 1 ? `${failure} (after ${attempt} attempts)` : failure);
      await sleep(attempt * 2000);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("the Releases API returned a body that is not JSON");
    }
    releases.push(...stableReleasesFromPage(body));
    if (body.length < PER_PAGE) return sortReleases(releases);
  }
  throw new Error(`the Releases API had more than ${maxPages} pages`);
}

/** The versions of a published-list file (snapshot or generated), or an error naming what is wrong. */
export function parsePublishedFile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("it is not a JSON object");
  if (value.schema !== SCHEMA) throw new Error(`its schema is not ${SCHEMA}`);
  if (!Array.isArray(value.published)) throw new Error('it has no "published" list');
  const bad = value.published.filter((version) => !isStableVersion(version));
  if (bad.length > 0) throw new Error(`"published" has ${bad.length} entr${bad.length === 1 ? "y that is" : "ies that are"} not a stable vYYYY.MDD.P version`);
  return value.published;
}

export function readPublishedFile(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(error.code === "ENOENT" ? "it does not exist" : "it is not valid JSON");
  }
  return parsePublishedFile(value);
}

/** The public list: versions, publishedAt and the source label, nothing else. */
export function renderPublicFile(releases, source) {
  const body = { schema: SCHEMA, source: source === "github-api" ? "api" : "snapshot", published: sortReleases(releases).map(({ version, publishedAt }) => ({ version, publishedAt: publishedAt ?? null })) };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function renderPublishedFile(versions, source) {
  const body = { schema: SCHEMA };
  if (source) body.source = source;
  body.published = sortVersions(versions);
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * The list the build uses: the API's when it can be read, else the snapshot's.
 * Returns { source: "github-api" | "snapshot", versions, releases, reason? };
 * releases carry publishedAt (null from the snapshot).
 */
export async function resolvePublishedVersions({ repoRoot, offline = false, repo, token, fetchImpl, maxPages, timeoutMs, attempts, sleep } = {}) {
  let reason = "offline mode";
  if (!offline) {
    try {
      const releases = await fetchPublishedReleases({ repo, token, fetchImpl, maxPages, timeoutMs, attempts, sleep });
      return { source: "github-api", versions: releases.map((release) => release.version), releases };
    } catch (error) {
      reason = error.message;
    }
  }
  let versions;
  try {
    versions = sortVersions(readPublishedFile(path.join(repoRoot, SNAPSHOT_REL)));
  } catch (error) {
    throw new Error(`${SNAPSHOT_REL} cannot be used: ${error.message}`);
  }
  return { source: "snapshot", versions, releases: versions.map((version) => ({ version, publishedAt: null })), reason };
}

/** Versions whose notes file exists and is neither withdrawn nor inherited from upstream. */
export function versionsWithNotes(repoRoot, versions) {
  const kept = [];
  const skipped = [];
  for (const version of versions) {
    const file = path.join(repoRoot, "releases", `${version}.md`);
    if (!existsSync(file)) {
      skipped.push(`${version} (no releases/${version}.md)`);
      continue;
    }
    const markdown = readFileSync(file, "utf8");
    if (/^>\s*Withdrawn, never released/im.test(markdown) || /^>\s*Upstream:/im.test(markdown)) {
      skipped.push(`${version} (withdrawn or upstream note)`);
      continue;
    }
    kept.push(version);
  }
  return { kept, skipped };
}

function parseArgs(argv) {
  const options = { offline: false, updateSnapshot: false, repo: DEFAULT_REPO, out: null, publicOut: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--offline") options.offline = true;
    else if (arg === "--update-snapshot") options.updateSnapshot = true;
    else if (arg === "--repo") options.repo = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--public-out") options.publicOut = argv[++i];
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const USAGE = `Usage:
  node scripts/published-releases.mjs [--offline] [--repo owner/name] [--out <file>] [--public-out <file>]
  node scripts/published-releases.mjs --update-snapshot [--repo owner/name]

Writes ${GENERATED_REL} (and the public copy ${PUBLIC_REL}) from the GitHub Releases API (GITHUB_TOKEN is used
when set; 3 attempts on network errors, 5xx, 403 and 429), falling back to
${SNAPSHOT_REL}, with a warning, when the API cannot be read.
--update-snapshot rewrites ${SNAPSHOT_REL} from the API and never falls back.`;

export async function main(argv, { env = process.env, fetchImpl, log = console.log, warn = console.warn, repoRoot, sleep } = {}) {
  const root = repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    warn(`published-releases: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  const token = env.GITHUB_TOKEN?.trim() || undefined;

  if (options.updateSnapshot) {
    let versions;
    try {
      versions = await fetchPublishedVersions({ repo: options.repo, token, fetchImpl, sleep });
    } catch (error) {
      warn(`published-releases: ${SNAPSHOT_REL} was not changed: ${error.message}.`);
      return 1;
    }
    const { kept, skipped } = versionsWithNotes(root, versions);
    for (const entry of skipped) warn(`published-releases: left out ${entry}`);
    writeFileSync(path.join(root, SNAPSHOT_REL), renderPublishedFile(kept));
    log(`Wrote ${SNAPSHOT_REL}: ${kept.length} published stable releases.`);
    return 0;
  }

  let resolved;
  try {
    resolved = await resolvePublishedVersions({ repoRoot: root, offline: options.offline, repo: options.repo, token, fetchImpl, sleep });
  } catch (error) {
    warn(`published-releases: ${error.message}`);
    return 1;
  }
  const out = path.resolve(root, options.out ?? GENERATED_REL);
  writeFileSync(out, renderPublishedFile(resolved.versions, resolved.source));
  const publicOut = path.resolve(root, options.publicOut ?? PUBLIC_REL);
  mkdirSync(path.dirname(publicOut), { recursive: true });
  writeFileSync(publicOut, renderPublicFile(resolved.releases, resolved.source));
  const shown = (file) => {
    const relative = path.relative(root, file);
    return relative.startsWith("..") ? file : relative;
  };
  const rel = `${shown(out)} and ${shown(publicOut)}`;
  if (resolved.source === "snapshot") {
    const prefix = env.GITHUB_ACTIONS === "true" ? "::warning::" : "";
    warn(
      `${prefix}published-releases: using ${SNAPSHOT_REL} because ${resolved.reason}. ` +
        "Versions published since the last snapshot refresh may be missing from www.agentdash.cloud/releases until the next build that can read the API.",
    );
  }
  const from = resolved.source === "github-api"
    ? `the GitHub Releases API (${options.repo}${token ? ", with GITHUB_TOKEN" : ", unauthenticated"})`
    : SNAPSHOT_REL;
  log(`Wrote ${rel}: ${resolved.versions.length} published stable releases from ${from}.`);
  return 0;
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
  process.exitCode = await main(process.argv.slice(2));
}
