import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkSchemaExports, checkLocalStorageBranding } from "./check-architecture.mjs";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "arch-check-"));
  mkdirSync(join(root, "packages/db/src/schema"), { recursive: true });
  mkdirSync(join(root, "ui/src"), { recursive: true });
  return root;
}

test("schema-export: flags a pgTable not re-exported from index.ts", () => {
  const root = makeRepo();
  try {
    const dir = join(root, "packages/db/src/schema");
    writeFileSync(join(dir, "widgets.ts"), `export const widgets = pgTable("widgets", {});`);
    writeFileSync(join(dir, "gadgets.ts"), `export const gadgets = pgTable("gadgets", {});`);
    // index re-exports widgets but NOT gadgets
    writeFileSync(join(dir, "index.ts"), `export { widgets } from "./widgets.js";`);

    const findings = checkSchemaExports(root);
    assert.equal(findings.length, 1);
    assert.match(findings[0].file, /gadgets\.ts$/);
    assert.match(findings[0].message, /not re-exported/);
    assert.match(findings[0].message, /\.\/gadgets\.js/); // remediation includes the fix
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema-export: ignores files with no pgTable", () => {
  const root = makeRepo();
  try {
    const dir = join(root, "packages/db/src/schema");
    writeFileSync(join(dir, "helpers.ts"), `export const noop = () => {};`);
    writeFileSync(join(dir, "index.ts"), `// nothing`);
    assert.deepEqual(checkSchemaExports(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("localstorage-branding: flags non-agentdash keys, allows agentdash.*", () => {
  const root = makeRepo();
  try {
    const f = join(root, "ui/src", "thing.tsx");
    writeFileSync(
      f,
      [
        `localStorage.setItem("paperclip:foo", "1");`,
        `localStorage.getItem("agentdash.bar");`, // OK — namespaced
      ].join("\n"),
    );
    const findings = checkLocalStorageBranding(root);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /paperclip:foo/);
    assert.match(findings[0].message, /agentdash\.foo/); // remediation strips the legacy prefix
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
