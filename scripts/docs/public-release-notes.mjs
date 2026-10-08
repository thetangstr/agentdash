// AgentDash: release files are historical evidence, not public browser inputs.
// This loader runs in Vite (including tests), before any markdown becomes a
// client module. Reuse the API changelog's parser and single withholding policy.
import { readFileSync } from "node:fs";
// Load the Node CLI module directly: Vite config bundling prepends helpers
// before its shebang, which would otherwise make that module invalid JS.
const { parseRelease, withheldReason } = await import(new URL("./generate-api-changelog.mjs", import.meta.url).href);

export function publicReleaseMarkdown(markdown) {
  const note = parseRelease(markdown);
  // Only structured metadata may cross the build boundary; titles and release
  // annotations can contain private prose just like bullets do.
  if (!/^v\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(note.version) || withheldReason(note.version)) {
    throw new Error("Invalid release version");
  }
  const out = [`# ${note.version}`];
  if (note.withdrawn) return `${out.join("\n")}\n> Withdrawn, never released.\n`;
  if (note.releasedAt) out.push(`> Released: ${note.releasedAt}`);
  if (note.upstream) out.push("> Upstream: Inherited release.");
  let section = null;
  for (const item of note.items) {
    if (/^(tests?|testing|validation|contributors)\b/i.test(item.section)) continue;
    if (withheldReason(item.section)) continue;
    // A safe-looking child of a private bullet is still about that private
    // subject. Check every ancestor, including wrapped continuation lines.
    let ancestor = item;
    while (ancestor && !withheldReason(ancestor.raw)) ancestor = ancestor.parent;
    if (ancestor) continue;
    if (section !== item.section) {
      section = item.section;
      out.push("", `## ${section}`);
    }
    out.push(`- ${item.raw}`);
  }
  return `${out.join("\n")}\n`;
}

export function publicReleaseNotesPlugin() {
  return {
    name: "agentdash-public-release-notes",
    enforce: "pre",
    load(id) {
      const suffix = "?public-release-note";
      if (!id.endsWith(suffix)) return null;
      const file = id.slice(0, -suffix.length);
      this.addWatchFile(file);
      return `export default ${JSON.stringify(publicReleaseMarkdown(readFileSync(file, "utf8")))};`;
    },
  };
}
