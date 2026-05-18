export interface ReleaseNoteSection {
  title: string;
  items: string[];
}

export interface ReleaseNote {
  version: string;
  releasedAt: string | null;
  sections: ReleaseNoteSection[];
  body: string;
}

const releaseModules = import.meta.glob("../../../releases/*.md", {
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

export function parseReleaseMarkdown(markdown: string): ReleaseNote {
  const body = markdown.trim();
  const lines = body.split(/\r?\n/);
  const version = lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() ?? "Unversioned";
  const releasedAt = lines
    .find((line) => /^>\s*Released:/i.test(line))
    ?.replace(/^>\s*Released:\s*/i, "")
    .trim() ?? null;

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

  return { version, releasedAt, sections, body };
}

function releaseSortValue(note: ReleaseNote) {
  if (!note.releasedAt) return 0;
  const parsed = Date.parse(note.releasedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function listReleaseNotes(): ReleaseNote[] {
  return Object.values(releaseModules)
    .map(parseReleaseMarkdown)
    .sort((a, b) => releaseSortValue(b) - releaseSortValue(a));
}
