import { describe, it, expect } from "vitest";

describe("inbox service", () => {
  it("module exports inboxService function", async () => {
    const mod = await import("../inbox.js");
    expect(typeof mod.inboxService).toBe("function");
  });

  it("service has expected methods", async () => {
    const mod = await import("../inbox.js");
    const svc = mod.inboxService(null as any);
    expect(typeof svc.listPending).toBe("function");
    expect(typeof svc.listRecent).toBe("function");
    expect(typeof svc.approve).toBe("function");
    expect(typeof svc.reject).toBe("function");
    expect(typeof svc.getDetail).toBe("function");
    expect(typeof svc.pendingCount).toBe("function");
  });
});
