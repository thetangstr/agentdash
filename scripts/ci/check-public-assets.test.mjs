import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanPublicAssets } from "./check-public-assets.mjs";
import { sha256 } from "../docs/forbidden-tokens.mjs";

test("scans all nested file types and reports only paths/counts, with one shared token policy", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdash-assets-scan-"));
  try {
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<h1>Public</h1>");
    writeFileSync(path.join(dir, "assets", "safe.js"), "safe text");
    writeFileSync(path.join(dir, "assets", "lazy.js"), 'const x = " FictionalDeniedIdentifier"');
    writeFileSync(path.join(dir, "assets", "original.map"), '"/fictionaldeniedidentifier"');
    const token = "fictionaldeniedidentifier";
    const result = scanPublicAssets(dir, [{ length: token.length, sha256: sha256(token) }]);
    assert.equal(result.scanned, 4);
    assert.deepEqual(result.findings, [
      { file: "assets/lazy.js", count: 1 },
      { file: "assets/original.map", count: 1 },
    ]);
    assert.equal(JSON.stringify(result).toLowerCase().includes(token), false);
    assert.equal(scanPublicAssets(dir, []).findings.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fails when the build output is missing rather than reporting a clean scan", () => {
  assert.throws(() => scanPublicAssets(path.join(tmpdir(), "agentdash-output-does-not-exist")), /ENOENT/);
});

test("classification requires both the exact code context and chunk, never merely an approved value", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdash-assets-context-"));
  const value = "fictionaldeniedidentifier";
  const token = { length: value.length, sha256: sha256(value) };
  const contexts = [{ context: "synthetic-protocol", file: /^assets\/index-[\w-]+\.js$/, token, syntax: "property:productProfile", before: /productProfile:"$/, after: /^",/ }];
  try {
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets", "index-test.js"), `const allowed={productProfile:"${value}",x:1}; const prose="The ${value} customer"; const codeInProse=\`productProfile:"${value}",\`; const unknown="otherdeniedidentifier";`);
    writeFileSync(path.join(dir, "assets", "docs-test.js"), `const unexpected={productProfile:"${value}",x:1};`);
    const unknown = "otherdeniedidentifier";
    const result = scanPublicAssets(dir, [token, { length: unknown.length, sha256: sha256(unknown) }], contexts);
    assert.deepEqual(result.classified, [{ file: "assets/index-test.js", context: "synthetic-protocol", count: 1 }]);
    assert.deepEqual(result.findings, [
      { file: "assets/docs-test.js", count: 1 },
      { file: "assets/index-test.js", count: 3 },
    ]);
    assert.equal(JSON.stringify(result).includes(value), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
