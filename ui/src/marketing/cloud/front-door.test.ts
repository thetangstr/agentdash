import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudApi, CloudApiError, SLUG_RE, slugify } from "./api";
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


afterEach(() => vi.unstubAllGlobals());

describe("hosted invitation API", () => {
  it("uses a first-party JSON body for session-bound redemption", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, provisioning: "waitlisted", reason: "at_capacity" })));
    vi.stubGlobal("fetch", fetch);
    await expect(cloudApi.redeemInvitation("AGD-TEST-ONLY")).resolves.toEqual({ ok: true, provisioning: "waitlisted", reason: "at_capacity" });
    expect(fetch).toHaveBeenCalledWith("/api/cloud/invitation/redeem", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "AGD-TEST-ONLY" }),
    });
  });

  it("preserves a refused invitation's HTTP status and error code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "This invitation is not available.", code: "invitation_invalid" }), { status: 400 })));
    await expect(cloudApi.redeemInvitation("invalid-test-code")).rejects.toMatchObject({ message: "This invitation is not available.", status: 400, code: "invitation_invalid" });
  });

  it("reports connection failures without losing retry guidance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(cloudApi.redeemInvitation("AGD-TEST-ONLY")).rejects.toBeInstanceOf(CloudApiError);
    await expect(cloudApi.redeemInvitation("AGD-TEST-ONLY")).rejects.toMatchObject({ status: 0, code: "network" });
  });
});
