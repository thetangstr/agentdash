import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_PAGE, SHIPPED_FILES, formatFinding, maskCode, navFiles, run, scanText } from "./check-docs-forbidden-tokens.mjs";
import { FORBIDDEN_TOKENS, forbiddenTokenOffsets, sha256 } from "../docs/forbidden-tokens.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "docs-tokens-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const nav = (pages) => JSON.stringify({ navigation: { tabs: [{ tab: "T", groups: [{ group: "G", pages }] }] } });

test("the shared hash list is well formed", () => {
  assert.ok(FORBIDDEN_TOKENS.length > 0);
  for (const token of FORBIDDEN_TOKENS) {
    assert.match(token.sha256, /^[0-9a-f]{64}$/);
    assert.ok(token.length > 0);
  }
});

test("the scan finds a hashed token at a word start, case-insensitively", () => {
  const needle = [{ length: 6, sha256: sha256("needle") }];
  assert.deepEqual(forbiddenTokenOffsets("hay NEEDLE hay", needle), [4]);
  assert.deepEqual(forbiddenTokenOffsets("x@needle.example", needle), [2]);
  assert.deepEqual(forbiddenTokenOffsets("haystack only", needle), []);
});

test("a short listed name matches only where a word starts with it", () => {
  // The name is already public in this repo's paths (scripts/ross/); the test
  // pins that word-start windows keep a 4-letter token off ordinary words.
  for (const fine of ["across the board", "gross margin", "crossover", "Across."]) {
    assert.deepEqual(forbiddenTokenOffsets(fine), [], fine);
  }
  assert.equal(forbiddenTokenOffsets("Ask Ross first.").length, 1);
  assert.equal(scanText("docs/x.md", "Line one.\nAsk Ross first.\n")[0]?.line, 2);
});

test("masking code keeps line numbers and blanks fences and spans", () => {
  const text = "a `b` c\n```sh\nd\n```\ne";
  const masked = maskCode(text);
  assert.equal(masked.split("\n").length, text.split("\n").length);
  assert.equal(masked.split("\n")[0], "a     c");
  assert.equal(masked.split("\n")[2].trim(), "");
  assert.equal(masked.split("\n")[4], "e");
});

test("upstream attribution and identifiers are allowed; retired organization links are refused", () => {
  const text = [
    "Intro.",
    "Paperclip is the old name.", // 2: prose
    "Set `PAPERCLIP_API_KEY` and send X-Paperclip-Run-Id.", // identifiers
    "Packages like @paperclipai/shared and the paperclipai CLI.",
    "```",
    "Paperclip in code is fine",
    "```",
    "See github.com/paperclip-ai/paperclip.", // 8: retired org
  ].join("\n");
  assert.deepEqual(scanText("docs/x.md", text), [
    { line: 8, rule: "paperclip" },
  ]);
});

test("every page may credit the public upstream without weakening private-token checks", () => {
  assert.deepEqual(scanText("docs/start/what-is-agentdash.md", "Built on [Paperclip](https://github.com/paperclipai/paperclip).\n"), []);
  assert.deepEqual(scanText("docs/start/what-is-agentdash.md", "Built on Paperclip. Ask Ross first.\n"), [{ line: 1, rule: "token" }]);
  assert.deepEqual(scanText(FORK_PAGE, "AgentDash is a fork of Paperclip.\n"), []);
});

test("a finding names the line, never the matched text", () => {
  const message = formatFinding("docs/x.md", { line: 3, rule: "token" });
  assert.equal(message.startsWith("docs/x.md:3: "), true);
  assert.doesNotMatch(message, /needle/);
});

test("it scans every nav page — denylisted or not — and reports unresolved entries", () => {
  const root = fixture({
    "docs/docs.json": nav(["a/one", "superpowers/two", "a/missing", "a/one"]),
    "docs/a/one.md": "# One\n",
    "docs/superpowers/two.md": "# Two\nSee github.com/paperclip-ai/paperclip.\n",
  });
  assert.deepEqual(navFiles(root), { files: ["docs/a/one.md", "docs/superpowers/two.md"], missing: ["a/missing"] });
  const { problems } = run(root);
  assert.ok(problems.some((p) => p.includes("lists a/missing")));
  assert.ok(problems.some((p) => p.startsWith("docs/superpowers/two.md:2: ")));
  // The shipped generated files are expected too; their absence is a problem in a fixture.
  for (const rel of SHIPPED_FILES.filter((file) => file !== "docs/docs.json")) {
    assert.ok(problems.includes(`${rel}: missing`), rel);
  }
});

test("explicit files are scanned on their own", () => {
  const root = fixture({ "docs/a.md": "Fine.\n", "docs/b.md": "See github.com/paperclip-ai/paperclip.\n" });
  assert.deepEqual(run(root, ["docs/a.md"]), { scanned: 1, problems: [] });
  assert.equal(run(root, ["docs/b.md"]).problems.length, 1);
});

test("the repository's public docs are clean", () => {
  const { scanned, problems } = run(REPO_ROOT);
  assert.deepEqual(problems, []);
  assert.ok(scanned >= 50, `scanned ${scanned}`);
});
