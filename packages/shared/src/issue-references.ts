export const ISSUE_REFERENCE_IDENTIFIER_RE = /^[A-Z]+-\d+$/;

export interface IssueReferenceMatch {
  index: number;
  length: number;
  identifier: string;
  matchedText: string;
}

// The identifier prefix is deliberately bounded: `[A-Z]+` under the `i` flag
// matched an entire alphabetic blob greedily and then backtracked one char at
// a time hunting `-\d+` — per start position, so a ~1MB plain-text blob made
// the scan O(n²) and pinned the event loop for minutes (UltraQA-B). Real
// issue prefixes are short codes; {1,64} keeps each start position O(64).
// The lookarounds make an oversize token (a longer letter run, or more than
// 15 digits) produce no match rather than a match on its tail or head.
const ISSUE_REFERENCE_TOKEN_RE =
  /https?:\/\/[^\s<>()]+|\/[^\s<>()]+|(?<![A-Z])[A-Z]{1,64}-[0-9]{1,15}(?![0-9])/gi;

function preserveNewlinesAsWhitespace(value: string) {
  return value.replace(/[^\n]/g, " ");
}

function stripMarkdownCode(markdown: string): string {
  if (!markdown) return "";

  let output = "";
  let index = 0;

  while (index < markdown.length) {
    const remaining = markdown.slice(index);
    const fenceMatch = /^(?:```+|~~~+)/.exec(remaining);
    const atLineStart = index === 0 || markdown[index - 1] === "\n";

    if (atLineStart && fenceMatch) {
      const fence = fenceMatch[0]!;
      const blockStart = index;
      index += fence.length;
      while (index < markdown.length && markdown[index] !== "\n") index += 1;
      if (index < markdown.length) index += 1;

      while (index < markdown.length) {
        const lineStart = index === 0 || markdown[index - 1] === "\n";
        if (lineStart && markdown.startsWith(fence, index)) {
          index += fence.length;
          while (index < markdown.length && markdown[index] !== "\n") index += 1;
          if (index < markdown.length) index += 1;
          break;
        }
        index += 1;
      }

      output += preserveNewlinesAsWhitespace(markdown.slice(blockStart, index));
      continue;
    }

    if (markdown[index] === "`") {
      let tickCount = 1;
      while (index + tickCount < markdown.length && markdown[index + tickCount] === "`") {
        tickCount += 1;
      }
      const fence = "`".repeat(tickCount);
      const inlineStart = index;
      index += tickCount;
      const closeIndex = markdown.indexOf(fence, index);
      if (closeIndex === -1) {
        output += markdown.slice(inlineStart, inlineStart + tickCount);
        index = inlineStart + tickCount;
        continue;
      }
      index = closeIndex + tickCount;
      output += preserveNewlinesAsWhitespace(markdown.slice(inlineStart, index));
      continue;
    }

    output += markdown[index]!;
    index += 1;
  }

  return output;
}

function trimTrailingPunctuation(token: string): string {
  // Opening brackets are never trimmed, so their counts are invariant; closing
  // counts shrink by one per `)`/`]` removed. Counting once up front keeps
  // this linear — recounting the whole remaining token per trimmed char was
  // O(n²) on a `/x]]]]…` token (UltraQA-B).
  let opensParen = 0;
  let closesParen = 0;
  let opensBracket = 0;
  let closesBracket = 0;
  for (const char of token) {
    if (char === "(") opensParen += 1;
    else if (char === ")") closesParen += 1;
    else if (char === "[") opensBracket += 1;
    else if (char === "]") closesBracket += 1;
  }

  let end = token.length;
  while (end > 0) {
    const last = token[end - 1]!;
    if (!".,!?;:".includes(last) && last !== ")" && last !== "]") break;

    if (
      (last === ")" && opensParen >= closesParen)
      || (last === "]" && opensBracket >= closesBracket)
    ) {
      break;
    }
    if (last === ")") closesParen -= 1;
    else if (last === "]") closesBracket -= 1;
    end -= 1;
  }
  return token.slice(0, end);
}

export function normalizeIssueIdentifier(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  return ISSUE_REFERENCE_IDENTIFIER_RE.test(trimmed) ? trimmed : null;
}

export function buildIssueReferenceHref(identifier: string): string {
  const normalized = normalizeIssueIdentifier(identifier);
  return `/issues/${normalized ?? identifier.trim()}`;
}

export function parseIssueReferenceHref(href: string): { identifier: string } | null {
  const raw = href.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = raw.startsWith("/")
      ? new URL(raw, "https://paperclip.invalid")
      : new URL(raw);
  } catch {
    return null;
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index]?.toLowerCase() !== "issues") continue;
    const identifier = normalizeIssueIdentifier(segments[index + 1] ?? "");
    if (identifier) {
      return { identifier };
    }
  }

  return null;
}

export function findIssueReferenceMatches(text: string): IssueReferenceMatch[] {
  if (!text) return [];

  const matches: IssueReferenceMatch[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(ISSUE_REFERENCE_TOKEN_RE);

  while ((match = re.exec(text)) !== null) {
    const rawToken = match[0];
    const cleanedToken = trimTrailingPunctuation(rawToken);
    if (!cleanedToken) continue;

    const identifier =
      normalizeIssueIdentifier(cleanedToken)
      ?? parseIssueReferenceHref(cleanedToken)?.identifier
      ?? null;

    if (!identifier) continue;

    const cleanedIndex = match.index;
    matches.push({
      index: cleanedIndex,
      length: cleanedToken.length,
      identifier,
      matchedText: cleanedToken,
    });
  }

  return matches;
}

export function extractIssueReferenceIdentifiers(markdown: string): string[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const match of findIssueReferenceMatches(scrubbed)) {
    if (seen.has(match.identifier)) continue;
    seen.add(match.identifier);
    ordered.push(match.identifier);
  }

  return ordered;
}

export function extractIssueReferenceMatches(markdown: string): IssueReferenceMatch[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: IssueReferenceMatch[] = [];

  for (const match of findIssueReferenceMatches(scrubbed)) {
    if (seen.has(match.identifier)) continue;
    seen.add(match.identifier);
    ordered.push(match);
  }

  return ordered;
}
