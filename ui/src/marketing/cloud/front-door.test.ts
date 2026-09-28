import { describe, expect, it } from "vitest";
import { SLUG_RE, slugify } from "./api";
import { readFragmentToken } from "../pages/StartVerify";
import { pollDelay } from "../pages/StartProgress";

describe("front door helpers (SC-7)", () => {
  it("suggests a slug the control plane accepts", () => {
    expect(slugify("Acme Robotics, Inc.")).toBe("acme-robotics-in");
    expect(slugify("  Café Olé ")).toBe("cafe-ole");
    expect(slugify("42 Labs")).toBe("labs");
    expect(SLUG_RE.test(slugify("Acme Robotics, Inc."))).toBe(true);
    expect(SLUG_RE.test("ab")).toBe(false);
    expect(SLUG_RE.test("acme-")).toBe(false);
    expect(SLUG_RE.test("a".repeat(17))).toBe(false);
  });

  it("reads the magic-link token from the fragment only", () => {
    const t = "A".repeat(43);
    expect(readFragmentToken(`#token=${t}`)).toBe(t);
    expect(readFragmentToken(`#x=1&token=${t}`)).toBe(t);
    expect(readFragmentToken("#token=short")).toBeNull();
    expect(readFragmentToken("")).toBeNull();
  });

  it("polls fast while provisioning, slowly while waiting, not at all when done", () => {
    const base = { slug: "a", url: "", state: "", stepIndex: null, slow: false, claimUrl: null, createdAt: "" };
    expect(pollDelay({ ...base, phase: "provisioning" })).toBe(4_000);
    expect(pollDelay({ ...base, phase: "waitlisted" })).toBe(30_000);
    expect(pollDelay({ ...base, phase: "ready" })).toBeNull();
  });
});
