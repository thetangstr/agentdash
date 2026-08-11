import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runtime-parity guard: assertions that must NOT run inside Vitest.
 *
 * Vitest's vite-node transform injects `require` into ESM modules. The server
 * does not have it. That difference is not academic — it shipped two bugs that
 * no unit test could have caught, because the test runner supplies the very
 * thing production is missing:
 *
 *   1. adapter-presets.ts hasBinary() -> readiness reported false for every
 *      local binary, so /health told an on-prem box it was broken while it was
 *      serving replies.
 *   2. cos-interview.ts systemPrompt() -> the Chief of Staff ran on a
 *      160-character stub instead of INTERVIEW.md, for months.
 *
 * Both were correct-looking code with a swallowed ReferenceError. A test written
 * against either one inside Vitest passes on the BROKEN version. The only way to
 * assert on this is to leave the test runner: spawn a real Node process, in the
 * same module system the server uses, and check the observable result.
 *
 * Add a case here whenever a module does something whose behaviour depends on
 * the runtime rather than on its own logic.
 */
describe("runtime parity (spawns a real process — does not trust the test runner)", () => {
  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  // A real .mts FILE, not --eval. `tsx --eval` defaults to CommonJS and so has
  // `require`, which would quietly restore the very asymmetry this file exists
  // to detect. The server loads ESM modules from disk; so does this.
  function runInRealNode(source: string): string {
    const file = join(mkdtempSync(join(tmpdir(), "agentdash-parity-")), "probe.mts");
    writeFileSync(file, source, "utf8");
    try {
      return execFileSync("npx", ["tsx", file], {
        cwd: serverRoot,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      }).trim();
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  }

  it("bare require() is NOT available in the server runtime", () => {
    // Pins the premise the rest of this file rests on. If this ever flips to
    // "yes", the guards below stop being meaningful and should be revisited.
    const out = runInRealNode(
      `try { require("node:fs"); console.log("yes"); } catch { console.log("no"); }`,
    );
    expect(out, "the runtime gained require(); re-evaluate these guards").toBe("no");
  });

  it("the CoS interview prompt loads the real asset in the server runtime", () => {
    const out = runInRealNode(
      `import("${serverRoot}/src/services/cos-interview.ts")` +
        `.then(m => console.log(m.__systemPromptForTest().length))` +
        `.catch(e => console.log("ERROR: " + e.message));`,
    );
    // The stub that shipped was 160 chars; INTERVIEW.md is ~1.1KB.
    expect(Number(out), `expected the real prompt, got: ${out}`).toBeGreaterThan(1000);
  });

  it("adapter readiness detects a real executable in the server runtime", () => {
    const out = runInRealNode(
      `process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";` +
        `process.env.AGENTDASH_HERMES_COMMAND = "/bin/sh";` +
        `delete process.env.PAPERCLIP_E2E_SKIP_LLM;` +
        `import("${serverRoot}/src/services/adapter-presets.ts")` +
        `.then(m => console.log(JSON.stringify(m.readAdapterStatus().ready)))` +
        `.catch(e => console.log("ERROR: " + e.message));`,
    );
    expect(out, "readiness lied about a binary that exists").toBe("true");
  });
});
