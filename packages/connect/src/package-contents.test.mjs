import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Pack the real tarball and check that what ships can actually run.
 *
 * Version 0.1.2 was published broken: `files` listed every source file by name,
 * a new `src/codes.mjs` was added and never added to that list, and the
 * published package died with ERR_MODULE_NOT_FOUND on its first command. Every
 * test passed, because tests run against the checkout — where the file exists.
 * CI was green, the registry was broken, and nothing in between noticed.
 *
 * So this asserts against the artifact rather than the source tree: pack it,
 * unpack it, and follow every relative import from the entry point. If a file
 * is missing from the package, this fails here instead of on a stranger's
 * machine.
 */

const pkgRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-pack-"));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function packAndExtract() {
  const out = execFileSync("npm", ["pack", "--pack-destination", workDir, "--silent"], {
    cwd: pkgRoot,
    encoding: "utf8",
  }).trim();
  const tarball = path.join(workDir, out.split("\n").pop());
  execFileSync("tar", ["xzf", tarball, "-C", workDir]);
  return path.join(workDir, "package");
}

/** Every `from "./x.mjs"` / `from "../x.mjs"` in a file. */
function relativeImports(source) {
  return [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
}

describe("the published package", () => {
  const root = packAndExtract();

  it("ships the entry point named in bin", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const binPath = Object.values(pkg.bin)[0];
    expect(fs.existsSync(path.join(root, binPath))).toBe(true);
  });

  it("ships every file it imports, transitively", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const entry = path.join(root, Object.values(pkg.bin)[0]);

    const missing = [];
    const seen = new Set();
    const queue = [entry];

    while (queue.length > 0) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);

      const source = fs.readFileSync(file, "utf8");
      for (const spec of relativeImports(source)) {
        const resolved = path.resolve(path.dirname(file), spec);
        if (!fs.existsSync(resolved)) {
          missing.push(`${path.relative(root, file)} imports ${spec}`);
          continue;
        }
        queue.push(resolved);
      }
    }

    expect(missing, `files imported but not packaged:\n${missing.join("\n")}`).toEqual([]);
    // Sanity: the walk must actually have visited the modules, or an empty
    // `missing` proves nothing.
    expect(seen.size).toBeGreaterThan(3);
  });

  it("runs --help from the packaged form", () => {
    // The end-to-end statement of the same thing: if it cannot print help, it
    // cannot do anything else either.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const entry = path.join(root, Object.values(pkg.bin)[0]);
    const output = execFileSync(process.execPath, [entry, "--help"], { encoding: "utf8" });
    expect(output).toMatch(/agentdash-connect/);
    expect(output).toMatch(/connect code/i);
  });

  it("does not ship its own tests", () => {
    const shipped = fs.readdirSync(path.join(root, "src"));
    expect(shipped.filter((f) => f.endsWith(".test.mjs"))).toEqual([]);
  });
});
