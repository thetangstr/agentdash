import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { publicReleaseMarkdown, publicReleaseNotesPlugin } from "../../../scripts/docs/public-release-notes.mjs";

const synthetic = `# v2026.1007.1
> Released: 2026-10-07 with an unreviewed deployment story

Unreviewed preamble which must not ship.

## Improvements
- Clearer task progress.
- **Private rollout** at secret-machine.internal
  - Innocent child that belongs to the private rollout.
- Improved navigation with wrapped detail
  reported by fictional-person@example.test
- Public performance fix.

## secret-machine.internal
- Must not keep a denied heading's children.

## Fixes
- Reliable approvals.
\`\`\`text
unreviewed fenced content
\`\`\`
`;

describe("public release-note build input", () => {
  it("keeps release metadata and useful sections while withholding private bullets, ancestry and prose", () => {
    expect(publicReleaseMarkdown(synthetic)).toBe(`# v2026.1007.1
> Released: 2026-10-07

## Improvements
- Clearer task progress.
- Public performance fix.

## Fixes
- Reliable approvals.
`);
  });

  it("preserves withdrawn/upstream flags without carrying their prose", () => {
    expect(publicReleaseMarkdown("# v0.3.1\n> Released: 2026-03-12\n> Upstream: secret-machine.internal\n")).toContain("> Upstream: Inherited release.");
    expect(publicReleaseMarkdown("# v2026.902.1\n> Withdrawn, never released. secret-machine.internal\n")).toBe("# v2026.902.1\n> Withdrawn, never released.\n");
  });

  it("rejects unstructured version metadata without echoing it", () => {
    expect(() => publicReleaseMarkdown("# private@example.test\n")).toThrow("Invalid release version");
  });

  it("never emits the raw source in production chunks or source maps", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentdash-public-release-"));
    try {
      writeFileSync(path.join(dir, "v2026.1007.1.md"), synthetic);
      writeFileSync(path.join(dir, "entry.js"), 'import note from "./v2026.1007.1.md?public-release-note"; globalThis.publicNote = note;');
      const result = await build({
        configFile: false, root: dir, logLevel: "silent", plugins: [publicReleaseNotesPlugin()],
        build: { write: false, sourcemap: true, rollupOptions: { input: path.join(dir, "entry.js") } },
      });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) => "output" in output ? output.output : []);
      expect(outputs.length).toBeGreaterThan(0);
      const emitted = outputs.map((output) => output.type === "chunk" ? output.code : String(output.source)).join("\n");
      expect(emitted).toContain("Reliable approvals.");
      expect(emitted).not.toMatch(/secret-machine|fictional-person|unreviewed|Innocent child|denied heading/i);
      expect(readFileSync(path.join(dir, "v2026.1007.1.md"), "utf8")).toBe(synthetic);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
