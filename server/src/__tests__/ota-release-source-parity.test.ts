// The release-source guard exists twice, and this is what stops that hurting.
//
// `server/src/services/ota-release-plan.ts` holds the TypeScript copy, used by
// the status endpoint. `scripts/deploy/ota-release-layout.mjs` holds the plain-JS
// copy, used by the standalone updater. They are duplicated on purpose: the
// updater is the tool you reach for when a deploy has gone wrong, so it must not
// depend on the application's build output existing. Importing compiled server
// code into it would make the repair tool fail in exactly the situation it is
// meant to handle.
//
// The cost of that choice is drift, and drift here is dangerous in a specific
// way: the board would offer an update the updater then refuses, or worse, the
// updater would accept a source the board would have rejected. So every case
// runs through both implementations and they must agree on the verdict.

import { describe, expect, it } from "vitest";
import { isAuthoritativeReleaseSource as tsGuard } from "../services/ota-release-plan.js";
import {
  isAuthoritativeReleaseSource as jsGuard,
  assertAuthoritativeReleaseSource,
} from "../../../scripts/deploy/ota-release-layout.mjs";

interface Source {
  remote: string;
  branch: string;
  tag: string | null;
  commitOnBranch: boolean;
}

const VALID: Source = { remote: "origin", branch: "main", tag: "v2026.827.2", commitOnBranch: true };

/** Every case both copies must classify identically. */
const CASES: Array<{ name: string; input: Source; expected: boolean }> = [
  { name: "release tag on origin/main", input: VALID, expected: true },
  { name: "another valid release tag", input: { ...VALID, tag: "v2026.1231.10" }, expected: true },
  { name: "feature branch", input: { ...VALID, branch: "fix/inbox-scope-and-steward-guard" }, expected: false },
  { name: "staging branch", input: { ...VALID, branch: "staging" }, expected: false },
  { name: "non-origin remote", input: { ...VALID, remote: "upstream" }, expected: false },
  { name: "no tag at all", input: { ...VALID, tag: null }, expected: false },
  { name: "non-release tag", input: { ...VALID, tag: "nightly" }, expected: false },
  { name: "semver-style tag", input: { ...VALID, tag: "v1.2.3" }, expected: false },
  { name: "tag without leading v", input: { ...VALID, tag: "2026.827.2" }, expected: false },
  { name: "tag not on main", input: { ...VALID, commitOnBranch: false }, expected: false },
];

describe("release-source guard parity", () => {
  for (const testCase of CASES) {
    it(`agrees on: ${testCase.name}`, () => {
      const fromTs = tsGuard(testCase.input);
      const fromJs = jsGuard(testCase.input);
      expect(fromTs.ok).toBe(testCase.expected);
      expect(fromJs.ok).toBe(testCase.expected);
      // Not just the same verdict — the same explanation, so the two surfaces
      // cannot tell a person two different stories about the same refusal.
      expect(fromJs).toEqual(fromTs);
    });
  }
});

describe("assertAuthoritativeReleaseSource", () => {
  it("passes a valid release source", () => {
    expect(() => assertAuthoritativeReleaseSource(VALID)).not.toThrow();
  });

  it("throws with the reason for an invalid one", () => {
    expect(() => assertAuthoritativeReleaseSource({ ...VALID, branch: "main-backup" })).toThrow(
      /Refusing to deploy: .*'main'/,
    );
  });

  // The MK host's actual state at the time this was written.
  it("refuses the branch the first design-partner host was serving", () => {
    expect(() =>
      assertAuthoritativeReleaseSource({
        remote: "origin",
        branch: "fix/inbox-scope-and-steward-guard",
        tag: null,
        commitOnBranch: true,
      }),
    ).toThrow(/Refusing to deploy/);
  });
});
