import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaticShellReader } from "../app.js";

/**
 * The blank-page bug, pinned.
 *
 * `index.html` was read once at startup and served from memory by the SPA
 * fallback, while `/` came off disk via express.static. After a UI rebuild the
 * asset hashes change, so every deep link served a shell pointing at a bundle
 * that no longer existed — the page rendered zero characters, with no error,
 * while `/` kept working. That asymmetry made it read as a routing fault, and
 * it bit repeatedly: on the sign-in page, on a bootstrap invite, and during a
 * navigation sweep that could not get past the first form.
 *
 * The header said `no-cache` throughout. The header was honest; the bytes were
 * not.
 */

let dir: string;
let indexPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-freshness-"));
  indexPath = path.join(dir, "index.html");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** mtime has coarse resolution on some filesystems; make the change unambiguous. */
function writeShell(contents: string, mtimeShiftSeconds = 0) {
  fs.writeFileSync(indexPath, contents, "utf-8");
  if (mtimeShiftSeconds) {
    const when = new Date(Date.now() + mtimeShiftSeconds * 1000);
    fs.utimesSync(indexPath, when, when);
  }
}

describe("createStaticShellReader", () => {
  it("serves a rebuilt shell without restarting the server", () => {
    writeShell('<script src="/assets/index-OLD.js"></script>');
    const read = createStaticShellReader(indexPath, (html) => html);

    expect(read()).toContain("index-OLD.js");

    // A rebuild: same path, new content, new asset hash.
    writeShell('<script src="/assets/index-NEW.js"></script>', 5);

    expect(read(), "a deep link would still point at the deleted bundle").toContain("index-NEW.js");
    expect(read()).not.toContain("index-OLD.js");
  });

  it("applies the branding transform to what it serves", () => {
    writeShell("<title>PLACEHOLDER</title>");
    const read = createStaticShellReader(indexPath, (html) =>
      html.replace("PLACEHOLDER", "AgentDash"),
    );

    expect(read()).toContain("<title>AgentDash</title>");
  });

  it("keeps serving the last good shell while the file is briefly missing", () => {
    // A rebuild replaces index.html non-atomically. Serving the previous shell
    // beats serving an empty page to whoever loads during that window.
    writeShell('<script src="/assets/index-A.js"></script>');
    const read = createStaticShellReader(indexPath, (html) => html);
    expect(read()).toContain("index-A.js");

    fs.rmSync(indexPath);

    expect(read()).toContain("index-A.js");
  });

  it("returns empty rather than throwing when the shell never existed", () => {
    const read = createStaticShellReader(path.join(dir, "absent.html"), (html) => html);
    expect(read()).toBe("");
  });
});
