export interface ReleaseNoteSection {
  title: string;
  items: string[];
}

export interface ReleaseNote {
  version: string;
  /** Leading YYYY-MM-DD of the `> Released:` line. Trailing prose is not part of it. */
  releasedAt: string | null;
  /** AgentDash: `> Withdrawn, never released.` — a cut that was drafted but never tagged. */
  withdrawn: boolean;
  /** AgentDash: `> Upstream: …` — Paperclip notes inherited with the fork, not an AgentDash release. */
  upstream: boolean;
  sections: ReleaseNoteSection[];
  body: string;
}

const releaseModules = import.meta.glob("../../../releases/v*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function cleanInlineMarkdown(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

/**
 * Takes the leading ISO date from a `> Released:` value. Notes often continue
 * with prose ("2026-09-14 as v2026.914.0."), which must stay out of the badge
 * and out of the sort key.
 */
export function parseReleasedDate(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})\b/.exec(value.trim());
  if (!match) return null;
  const date = match[1]!;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? null : date;
}

export function parseReleaseMarkdown(markdown: string): ReleaseNote {
  const body = markdown.trim();
  const lines = body.split(/\r?\n/);
  const version = lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() ?? "Unversioned";
  const releasedLine = lines.find((line) => /^>\s*Released:/i.test(line));
  const releasedAt = releasedLine ? parseReleasedDate(releasedLine.replace(/^>\s*Released:\s*/i, "")) : null;
  const withdrawn = lines.some((line) => /^>\s*Withdrawn, never released/i.test(line));
  const upstream = lines.some((line) => /^>\s*Upstream:/i.test(line));

  const sections: ReleaseNoteSection[] = [];
  let current: ReleaseNoteSection | null = null;

  for (const line of lines) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      current = { title: heading[1]!.trim(), items: [] };
      sections.push(current);
      continue;
    }

    const item = /^-\s+(.+)$/.exec(line);
    if (item && current) {
      current.items.push(cleanInlineMarkdown(item[1]!.trim()));
    }
  }

  return { version, releasedAt, withdrawn, upstream, sections, body };
}

function versionParts(version: string) {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

/** Newest first: release date, then version (three cuts on 2026-09-09 share a date). */
export function compareReleaseNotes(a: ReleaseNote, b: ReleaseNote) {
  const dateA = a.releasedAt ? Date.parse(`${a.releasedAt}T00:00:00Z`) : 0;
  const dateB = b.releasedAt ? Date.parse(`${b.releasedAt}T00:00:00Z`) : 0;
  if (dateA !== dateB) return dateB - dateA;
  const pa = versionParts(a.version);
  const pb = versionParts(b.version);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pb[i]! - pa[i]!;
  }
  return 0;
}

/** Released notes, newest first. Withdrawn cuts are left out of the in-app changelog. */
export function listReleaseNotes(): ReleaseNote[] {
  return Object.values(releaseModules)
    .map(parseReleaseMarkdown)
    .filter((note) => !note.withdrawn)
    .sort(compareReleaseNotes);
}
