type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const BARE_ISSUE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]+-\d+$/i;
// AgentDash: bare `WORD-123` tokens in prose used to link anything shaped like an
// identifier, e.g. `bd42-4916` inside a UUID or the model name `GPT-4`, and each
// link fetched a nonexistent issue. Bare identifiers are now scoped to the viewer's
// company issue prefixes, or to a letters-only prefix when there is no company
// context (company prefixes are letters only, see deriveIssuePrefixBase on the
// server). A token whose prefix is all hex and that touches `<hex>-` or `-<hex>` is
// a UUID group; real references glued into branch names (`ACME-60-fix-login`,
// `re-ACME-60`) keep linking because ACME is not hex.
const BARE_ISSUE_IDENTIFIER_PARTS_RE = /^([A-Z][A-Z0-9]*)-(\d+)$/i;
const LETTER_ONLY_UPPERCASE_PREFIX_RE = /^[A-Z]{2,}$/;
const HEX_ONLY_PREFIX_RE = /^[0-9A-F]+-/i;
const UUID_NEIGHBOR_BEFORE_RE = /[0-9a-f]-$/i;
const UUID_NEIGHBOR_AFTER_RE = /^-[0-9a-f]/i;
const FULL_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISSUE_SCHEME_RE = /^issue:\/\/:?([^?#\s]+)(?:[?#].*)?$/i;
const ISSUE_REFERENCE_TOKEN_RE = /issue:\/\/:?[^\s<>()]+|https?:\/\/[^\s<>()]+|\/(?:[^\s<>()/]+\/)*issues\/[A-Z][A-Z0-9]+-\d+(?=$|[\s<>)\],.;!?:])|\b[A-Z][A-Z0-9]+-\d+\b/gi;

export function parseIssuePathIdFromPath(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  const pathname = pathOrUrl.trim();
  if (!pathname) return null;
  if (/^https?:\/\//i.test(pathname)) return null;

  const segments = pathname.split("/").filter(Boolean);
  const issueIndex = segments.findIndex((segment) => segment === "issues");
  if (issueIndex === -1 || issueIndex === segments.length - 1) return null;
  const issuePathId = decodeURIComponent(segments[issueIndex + 1] ?? "");
  if (!issuePathId || issuePathId.startsWith(":")) return null;
  return BARE_ISSUE_IDENTIFIER_RE.test(issuePathId) ? issuePathId.toUpperCase() : issuePathId;
}

export interface IssueReferenceOptions {
  /**
   * Issue prefixes of the companies the viewer can see (e.g. `["ACME"]`). When
   * given, a bare `PREFIX-123` identifier is only an issue reference if its prefix
   * is one of these; an empty list (companies still loading) links no bare
   * identifiers at all. When null or omitted (no company context), a bare
   * identifier falls back to a letters-only prefix.
   */
  issuePrefixes?: readonly string[] | null;
}

function normalizedIssuePrefixes(options: IssueReferenceOptions | undefined): Set<string> | null {
  const prefixes = options?.issuePrefixes;
  if (!prefixes) return null;
  const normalized = new Set<string>();
  for (const prefix of prefixes) {
    if (typeof prefix !== "string") continue;
    const trimmed = prefix.trim().toUpperCase();
    if (trimmed) normalized.add(trimmed);
  }
  return normalized;
}

/**
 * Whether a bare `PREFIX-123` token names an issue. `requireUppercase` is set for
 * tokens found in running prose, where lowercase words like `step-2` are common;
 * explicit link targets and inline code keep case-insensitive matching.
 */
function isBareIssueIdentifier(
  value: string,
  options: IssueReferenceOptions | undefined,
  requireUppercase: boolean,
): boolean {
  const parts = value.match(BARE_ISSUE_IDENTIFIER_PARTS_RE);
  if (!parts) return false;
  const prefix = parts[1]!;
  const knownPrefixes = normalizedIssuePrefixes(options);
  if (knownPrefixes) return knownPrefixes.has(prefix.toUpperCase());
  return LETTER_ONLY_UPPERCASE_PREFIX_RE.test(requireUppercase ? prefix : prefix.toUpperCase());
}

export function parseIssueReferenceFromHref(
  href: string | null | undefined,
  options?: IssueReferenceOptions,
) {
  return parseIssueReference(href, options, false);
}

function parseIssueReference(
  href: string | null | undefined,
  options: IssueReferenceOptions | undefined,
  requireUppercase: boolean,
) {
  if (!href) return null;
  const trimmed = href.trim();
  const issueSchemeMatch = trimmed.match(ISSUE_SCHEME_RE);
  if (issueSchemeMatch?.[1]) {
    const issuePathId = decodeURIComponent(issueSchemeMatch[1]);
    return {
      issuePathId,
      href: `/issues/${encodeURIComponent(issuePathId)}`,
    };
  }

  const pathId = parseIssuePathIdFromPath(href);
  if (pathId) {
    return {
      issuePathId: pathId,
      href: `/issues/${encodeURIComponent(pathId)}`,
    };
  }

  if (!isBareIssueIdentifier(trimmed, options, requireUppercase)) return null;
  const normalized = trimmed.toUpperCase();
  return {
    issuePathId: normalized,
    href: `/issues/${encodeURIComponent(normalized)}`,
  };
}

function splitTrailingPunctuation(token: string) {
  let core = token;
  let trailing = "";

  while (core.length > 0) {
    const lastChar = core.at(-1);
    if (!lastChar || !/[),.;!?:\]]/.test(lastChar)) break;
    if (lastChar === ")") {
      const openCount = (core.match(/\(/g) ?? []).length;
      const closeCount = (core.match(/\)/g) ?? []).length;
      if (closeCount <= openCount) break;
    }
    if (lastChar === "]") {
      const openCount = (core.match(/\[/g) ?? []).length;
      const closeCount = (core.match(/\]/g) ?? []).length;
      if (closeCount <= openCount) break;
    }
    trailing = `${lastChar}${trailing}`;
    core = core.slice(0, -1);
  }

  return { core, trailing };
}

function createIssueLinkNode(value: string, href: string, childType: "text" | "inlineCode" = "text"): MarkdownNode {
  return {
    type: "link",
    url: href,
    children: [{ type: childType, value }],
  };
}

function isInsideUuid(
  value: string,
  token: string,
  start: number,
  end: number,
  options: IssueReferenceOptions | undefined,
): boolean {
  if (!HEX_ONLY_PREFIX_RE.test(token)) return false;
  // AgentDash (GH #863 item 3): a company whose prefix is all hex (ABC, CAF, FAB,
  // BED, DEF) would otherwise lose `ABC-12-fix-login` and `re-ABC-12`, because
  // their neighbours look like UUID groups. A known company prefix is trusted
  // unless the token really sits inside a complete UUID.
  const prefix = token.match(BARE_ISSUE_IDENTIFIER_PARTS_RE)?.[1];
  const knownPrefixes = normalizedIssuePrefixes(options);
  if (prefix && knownPrefixes?.has(prefix.toUpperCase())) {
    for (const uuid of value.matchAll(FULL_UUID_RE)) {
      const uuidStart = uuid.index ?? 0;
      if (start >= uuidStart && end <= uuidStart + uuid[0].length) return true;
    }
    return false;
  }
  return UUID_NEIGHBOR_BEFORE_RE.test(value.slice(Math.max(0, start - 2), start))
    || UUID_NEIGHBOR_AFTER_RE.test(value.slice(end, end + 2));
}

function linkifyIssueReferencesInText(value: string, options: IssueReferenceOptions | undefined): MarkdownNode[] | null {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  let matched = false;

  for (const match of value.matchAll(ISSUE_REFERENCE_TOKEN_RE)) {
    const raw = match[0];
    if (!raw) continue;

    const start = match.index ?? 0;
    const end = start + raw.length;
    const { core, trailing } = splitTrailingPunctuation(raw);
    const isBareToken = BARE_ISSUE_IDENTIFIER_RE.test(core);
    if (isBareToken && isInsideUuid(value, core, start, start + core.length, options)) continue;
    const issueRef = parseIssueReference(core, options, isBareToken);
    if (!issueRef) continue;

    matched = true;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    nodes.push(createIssueLinkNode(core, issueRef.href));
    if (trailing) {
      nodes.push({ type: "text", value: trailing });
    }
    cursor = end;
  }

  if (!matched) return null;
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

function rewriteMarkdownTree(node: MarkdownNode, options: IssueReferenceOptions | undefined) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  if (node.type === "link" || node.type === "linkReference" || node.type === "code" || node.type === "definition" || node.type === "html") {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const issueRef = parseIssueReferenceFromHref(child.value, options);
      if (issueRef) {
        nextChildren.push(createIssueLinkNode(child.value, issueRef.href, "inlineCode"));
        continue;
      }
    }

    if (child.type === "text" && typeof child.value === "string") {
      const linked = linkifyIssueReferencesInText(child.value, options);
      if (linked) {
        nextChildren.push(...linked);
        continue;
      }
    }

    rewriteMarkdownTree(child, options);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkLinkIssueReferences(options?: IssueReferenceOptions) {
  return (tree: MarkdownNode) => {
    rewriteMarkdownTree(tree, options);
  };
}
