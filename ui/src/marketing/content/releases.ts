import { listReleaseNotes, type ReleaseNote } from "@/lib/release-notes";
import snapshot from "../../../../releases/published.json";
import { GITHUB_URL } from "./site";

/**
 * AgentDash: the public release-notes pages at /releases.
 *
 * Content is the bundled notes from `listReleaseNotes()`, already reduced by
 * the build-time sanitizer (scripts/docs/public-release-notes.mjs), the same
 * withholding policy as the in-app Changelog. Raw markdown never ships.
 *
 * Only versions with a published stable GitHub Release are listed. Vercel's
 * build writes that list into published-releases.generated.json
 * (scripts/published-releases.mjs): from the GitHub Releases API, or, when it
 * cannot be read, from the committed snapshot releases/published.json. A
 * build without the generated file (tests, Docker, self-hosted) reads the
 * snapshot directly.
 * A version is therefore listed only when one of those sources has it and its
 * notes file is neither withdrawn nor inherited from upstream.
 *
 * The in-app Changelog is not filtered: a self-hosted build made from a tag
 * cannot know whether its own release has been published yet.
 */
export const RELEASES_PATH = "/releases";

const STABLE_VERSION = /^v\d{4}\.\d{3,4}\.\d+$/;

export type PublishedSource = "github-api" | "snapshot";
const SOURCES: readonly PublishedSource[] = ["github-api", "snapshot"];

export interface PublishedReleases {
  source: PublishedSource;
  versions: readonly string[];
}

/** The versions of a published-list file, or null when it is not one. */
export function readPublishedVersions(value: unknown): string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const file = value as { schema?: unknown; published?: unknown };
  if (file.schema !== 1 || !Array.isArray(file.published)) return null;
  const versions = file.published;
  if (!versions.every((version): version is string => typeof version === "string" && STABLE_VERSION.test(version))) return null;
  return [...new Set(versions)];
}

/** The generated list when the build wrote a valid one, else the committed snapshot. */
export function resolvePublishedReleases(generated: unknown, fallback: unknown): PublishedReleases {
  const fromBuild = readPublishedVersions(generated);
  if (fromBuild) {
    const declared = (generated as { source?: unknown }).source;
    const source = SOURCES.find((known) => known === declared) ?? "snapshot";
    return { source, versions: fromBuild };
  }
  return { source: "snapshot", versions: readPublishedVersions(fallback) ?? [] };
}

// Absent unless the build ran scripts/published-releases.mjs; the glob is then empty.
const generatedModules = import.meta.glob<unknown>("./published-releases.generated.json", { eager: true, import: "default" });

export function publishedReleases(): PublishedReleases {
  return resolvePublishedReleases(Object.values(generatedModules)[0], snapshot);
}

/** Notes with a published release, newest first (the order of `notes`). */
export function selectPublishedReleaseNotes(notes: readonly ReleaseNote[], versions: Iterable<string>): ReleaseNote[] {
  const published = new Set(versions);
  return notes.filter((note) => !note.withdrawn && !note.upstream && published.has(note.version));
}

export function listPublishedReleaseNotes(): ReleaseNote[] {
  return selectPublishedReleaseNotes(listReleaseNotes(), publishedReleases().versions);
}

export function findPublishedReleaseNote(version: string | undefined, notes: readonly ReleaseNote[] = listPublishedReleaseNotes()): ReleaseNote | null {
  if (!version) return null;
  return notes.find((note) => note.version === version) ?? null;
}

export function releasePath(version: string): string {
  return `${RELEASES_PATH}/${version}`;
}

export function githubReleaseUrl(version: string): string {
  return `${GITHUB_URL}/releases/tag/${version}`;
}

/** "2026-11-05" -> "November 5, 2026", read as a calendar date (no time zone shift). */
export function formatReleaseDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
}

/** The first public bullet, from "What's new" when the note has it. */
export function releaseSummary(note: ReleaseNote): string | null {
  const whatsNew = note.sections.find((section) => /^what[’']s new$/i.test(section.title.trim()));
  const section = whatsNew?.items.length ? whatsNew : note.sections.find((candidate) => candidate.items.length > 0);
  return section?.items[0] ?? null;
}

export function countReleaseItems(note: ReleaseNote): number {
  return note.sections.reduce((total, section) => total + section.items.length, 0);
}
