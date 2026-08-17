import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitSignal, resetSignalSubscribersForTest } from "./signals.js";
import { readAlerterConfigFromEnv, startAlerter } from "./alerter.js";

const fetchMock = vi.fn();

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("alerter", () => {
  beforeEach(() => {
    resetSignalSubscribersForTest();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CONFIG = {
    apiKey: "re_test_key",
    from: "alerts@example.test",
    to: ["a@example.test", "b@example.test"],
    publicBaseUrl: "http://mkmini.local:3102",
  };

  it("sends a signal as one email to all recipients", async () => {
    startAlerter(CONFIG);
    emitSignal({ kind: "run_failed", summary: "agent Dex run failed" });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(CONFIG.to);
    expect(body.subject).toContain("run_failed");
  });

  it("never puts signal detail into the email — only summary, kind, time, link", async () => {
    // The egress rule, falsified: put client-looking content into detail and
    // prove it does not leave.
    startAlerter(CONFIG);
    emitSignal({
      kind: "server_error",
      summary: "POST /api/issues 500",
      detail: { fingerprint: "abc", requestBody: "CLIENT-SECRET-CONTENT" },
    });
    await flush();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).not.toContain("CLIENT-SECRET-CONTENT");
    expect(init.body).toContain("POST /api/issues 500");
  });

  it("debounces repeats of the same fingerprint, counts them", async () => {
    startAlerter(CONFIG);
    for (let i = 0; i < 3; i++) {
      emitSignal({ kind: "server_error", summary: "same crash", detail: { fingerprint: "f1" } });
    }
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a different fingerprint is not debounced", async () => {
    startAlerter(CONFIG);
    emitSignal({ kind: "server_error", summary: "crash one", detail: { fingerprint: "f1" } });
    emitSignal({ kind: "server_error", summary: "crash two", detail: { fingerprint: "f2" } });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("unconfigured: sends nothing, but COUNTS what it dropped", async () => {
    // The decoy-transport lesson: silence must be measurable.
    const status = startAlerter({ apiKey: null, from: null, to: [], publicBaseUrl: null });
    expect(status.configured).toBe(false);

    emitSignal({ kind: "backup_failed", summary: "dump failed" });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    const { alerterStatus } = await import("./alerter.js");
    expect(alerterStatus().droppedSinceBoot).toBeGreaterThanOrEqual(1);
  });

  it("a failed send is recorded, not thrown", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    startAlerter(CONFIG);
    emitSignal({ kind: "budget_stop", summary: "cap hit" });
    await flush();

    const { alerterStatus } = await import("./alerter.js");
    expect(alerterStatus().lastSendError).toBe("resend 403");
  });

  it("reads recipients as a comma-separated list from env", () => {
    const config = readAlerterConfigFromEnv({
      AGENTDASH_ALERT_RESEND_API_KEY: "re_x",
      AGENTDASH_ALERT_FROM: "alerts@example.test",
      AGENTDASH_ALERT_TO: "a@example.test, b@example.test",
    } as NodeJS.ProcessEnv);
    expect(config.to).toEqual(["a@example.test", "b@example.test"]);
    expect(config.apiKey).toBe("re_x");
  });
});
