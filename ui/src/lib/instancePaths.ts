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
// "…/instances/<instance>/workspaces/<workspace>/<relative path>"
const WORKSPACE_PATH_RE =
  /[^\s"'`()[\]{}<>]*\/instances\/[^\s"'`()[\]{}<>/]+\/workspaces\/[^\s"'`()[\]{}<>/]+(?:\/[^\s"'`()[\]{}<>]*)?/g;
// Any other file under "…/instances/<instance>/" (config, logs, secrets dir).
const INSTANCE_PATH_RE =
  /[^\s"'`()[\]{}<>]*\/instances\/[^\s"'`()[\]{}<>/]+\/[^\s"'`()[\]{}<>/][^\s"'`()[\]{}<>]*/g;

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
    .replace(WORKSPACE_PATH_RE, (match) => {
      const [path, suffix] = splitTrailingPunctuation(match);
      const marker = "/workspaces/";
      const after = path.slice(path.indexOf(marker) + marker.length);
      const slash = after.indexOf("/");
      // The workspace dir alone is the workspace id; deeper paths show relative.
      const short = slash === -1 ? basename(after) : after.slice(slash + 1);
      return (short || basename(path)) + suffix;
    })
    .replace(INSTANCE_PATH_RE, (match) => {
      const [path, suffix] = splitTrailingPunctuation(match);
      return basename(path) + suffix;
    });
}
