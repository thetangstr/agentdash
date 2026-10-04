/**
 * AgentDash (batch 3): agents quote the files they wrote by their real on-disk
 * path — "/paperclip/instances/default/workspaces/43e8…/competitor-scan.md",
 * where the root is the server's $PAPERCLIP_HOME. In owner-facing summaries and
 * readable transcripts that whole prefix is infrastructure noise: a path under
 * a workspace shows as its path inside the workspace ("competitor-scan.md",
 * "notes/plan.md"), and any other instance-internal file (logs, config) shows
 * as its file name. Expanded tool output and the Raw transcript keep the full
 * path.
 */

// A path token is everything between whitespace/quotes/brackets. Trailing
// sentence punctuation (".", ",") is not part of the path.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

// AgentDash (review #1016): a match must start at a token boundary or right
// after "=" (KEY=value), and the path itself must be a filesystem root —
// "/", "~/", or "file://" — with a "paperclip"/".paperclip" home segment
// directly before "/instances/". Mid-token "/instances/" is not enough:
// https URLs keep their host, /Users/…/aws/instances/… is not ours, and a
// KEY= prefix is never swallowed.
const TOKEN_BOUNDARY = "(^|[\\s\"'`()\\[\\]{}<>]|=)";
const PATH_ROOT = "(?:file:\\/\\/|~\\/|\\/)";
const DELIM = "^\\s\"'`()\\[\\]{}<>";
const LAZY_SEGMENTS = `[${DELIM}]*?`;
const GREEDY_SEGMENTS = `[${DELIM}]*`;
const HOME_SEGMENT = "(?:\\.paperclip|paperclip)";
const ONE_SEGMENT = `[${DELIM}/]+`;

// "<root>…/(paperclip|.paperclip)/instances/<instance>/workspaces/<ws>/<rel>"
const WORKSPACE_PATH_RE = new RegExp(
  TOKEN_BOUNDARY +
    `(${PATH_ROOT}(?:${LAZY_SEGMENTS}/)?${HOME_SEGMENT}/instances/${ONE_SEGMENT}/workspaces/${ONE_SEGMENT}(?:/${GREEDY_SEGMENTS})?)`,
  "g",
);
// Any other file under "<root>…/(paperclip|.paperclip)/instances/<instance>/".
const INSTANCE_PATH_RE = new RegExp(
  TOKEN_BOUNDARY +
    `(${PATH_ROOT}(?:${LAZY_SEGMENTS}/)?${HOME_SEGMENT}/instances/${ONE_SEGMENT}/${ONE_SEGMENT}${GREEDY_SEGMENTS})`,
  "g",
);

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Splits sentence punctuation off the end of a matched path token. */
function splitTrailingPunctuation(path: string): [string, string] {
  const trailing = TRAILING_PUNCTUATION.exec(path)?.[0] ?? "";
  return [path.slice(0, path.length - trailing.length), trailing];
}

export function shortenInstancePaths(text: string): string {
  return text
    .replace(WORKSPACE_PATH_RE, (_match, boundary: string, path: string) => {
      const [clean, suffix] = splitTrailingPunctuation(path);
      const marker = "/workspaces/";
      const after = clean.slice(clean.lastIndexOf(marker) + marker.length);
      const slash = after.indexOf("/");
      // The workspace dir alone is the workspace id; deeper paths show relative.
      const short = slash === -1 ? basename(after) : after.slice(slash + 1);
      return boundary + (short || basename(clean)) + suffix;
    })
    .replace(INSTANCE_PATH_RE, (_match, boundary: string, path: string) => {
      const [clean, suffix] = splitTrailingPunctuation(path);
      return boundary + basename(clean) + suffix;
    });
}
