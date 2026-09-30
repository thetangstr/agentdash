import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grownEntries, isTestFile, parseAllowlist, scan } from "./check-no-profile-ux.mjs";

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "profile-ux-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test("flags a profile branch in a non-test ui/src file", () => {
  const root = fixture({
    "ui/src/components/Nav.tsx": 'const isMk = c.productProfile === "agentdash_mk";\n',
    "ui/src/components/Clean.tsx": "export const x = 1;\n",
  });
  try {
    const { offenders } = scan(root, []);
    assert.equal(offenders.length, 1);
    assert.match(offenders[0], /^ui\/src\/components\/Nav\.tsx:1:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores test files and allowlisted files; reports stale entries", () => {
  const root = fixture({
    "ui/src/components/Nav.test.tsx": 'productProfile: "agentdash_mk"\n',
    "ui/src/__tests__/x.ts": "agentdash_mk\n",
    "ui/src/pages/Legacy.tsx": "selectedCompany?.productProfile\n",
  });
  try {
    const { offenders, stale } = scan(root, ["ui/src/pages/Legacy.tsx", "ui/src/pages/Gone.tsx"]);
    assert.deepEqual(offenders, []);
    assert.deepEqual(stale, ["ui/src/pages/Gone.tsx"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the allowlist may shrink but not grow", () => {
  assert.deepEqual(grownEntries(["a"], ["a", "b"]), []);
  assert.deepEqual(grownEntries(["a", "c"], ["a", "b"]), ["c"]);
});

test("parseAllowlist accepts an array or a files object", () => {
  assert.deepEqual(parseAllowlist('["a"]'), ["a"]);
  assert.deepEqual(parseAllowlist('{"_comment":"x","files":["b"]}'), ["b"]);
  assert.throws(() => parseAllowlist('{"files":[1]}'));
});

test("isTestFile", () => {
  assert.equal(isTestFile("ui/src/a.test.tsx"), true);
  assert.equal(isTestFile("ui/src/a.spec.ts"), true);
  assert.equal(isTestFile("ui/src/__tests__/a.ts"), true);
  assert.equal(isTestFile("ui/src/a.tsx"), false);
});
