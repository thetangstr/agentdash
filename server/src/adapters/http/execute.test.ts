import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../types.js";
import { execute } from "./execute.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("http adapter execute", () => {
  it("reports configured request timeout as timed_out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })),
    );

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent",
        adapterType: "http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        url: "https://example.test/webhook",
        timeoutMs: 1,
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });
});

// AgentDash: exercise the actual fetch/AbortController boundary, not just a mock
// rejecting with AbortError. Each test owns only its ephemeral loopback listener.
function executionContext(url: string, config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-http-timeout",
    agent: { id: "agent-http", companyId: "company-http", name: "HTTP", adapterType: "http", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { url, ...config },
    context: { taskId: "synthetic-task" },
    onLog: async () => {},
  };
}

async function withEndpoint(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  check: (url: string) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    await check(`http://127.0.0.1:${port}/invoke`);
  } finally {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    server.closeAllConnections();
    await closed;
    expect(server.listening).toBe(false);
  }
}

function delayedResponse(delayMs: number) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    const responseTimer = setTimeout(() => res.end("ok"), delayMs);
    res.once("close", () => clearTimeout(responseTimer));
  };
}

describe("HTTP documented timeout with a real endpoint", () => {
  it("aborts a request configured with timeoutSec and closes the connection", async () => {
    let closedBeforeResponse = false;
    let received = false;
    await withEndpoint((req, res) => {
      received = true;
      res.once("close", () => { closedBeforeResponse = !res.writableFinished; });
      delayedResponse(500)(req, res);
    }, async (url) => {
      const result = await execute(executionContext(url, { timeoutSec: 0.15 }));
      expect(result).toMatchObject({ timedOut: true, errorCode: "timeout", exitCode: null });
      expect(result.errorMessage).toContain("150ms");
      await vi.waitFor(() => expect(closedBeforeResponse).toBe(true));
      expect(received).toBe(true);
    });
  });

  it("retains timeoutMs for legacy configs", async () => {
    await withEndpoint(delayedResponse(500), async (url) => {
      expect(await execute(executionContext(url, { timeoutMs: 100 })))
        .toMatchObject({ timedOut: true, errorCode: "timeout" });
    });
  });

  it("uses seconds before legacy milliseconds", async () => {
    await withEndpoint(delayedResponse(100), async (url) => {
      expect(await execute(executionContext(url, { timeoutSec: 0.5, timeoutMs: 1 })))
        .toMatchObject({ timedOut: false, exitCode: 0 });
    });
  });

  it.each([0, -1])("explicit seconds %s disable even a legacy timeout", async (timeoutSec) => {
    await withEndpoint(delayedResponse(50), async (url) => {
      expect(await execute(executionContext(url, { timeoutSec, timeoutMs: 1 })))
        .toMatchObject({ timedOut: false, exitCode: 0 });
    });
  });

  it.each([undefined, null, "1", NaN, Infinity])("invalid seconds %s use the legacy timeout", async (timeoutSec) => {
    await withEndpoint(delayedResponse(500), async (url) => {
      expect(await execute(executionContext(url, { timeoutSec, timeoutMs: 100 })))
        .toMatchObject({ timedOut: true, errorCode: "timeout" });
    });
  });

  it.each([{}, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: Infinity }, { timeoutSec: "1" }])
    ("allows a delayed response without a positive valid timeout: %j", async (config) => {
      await withEndpoint(delayedResponse(50), async (url) => {
        expect(await execute(executionContext(url, config)))
          .toMatchObject({ timedOut: false, exitCode: 0 });
      });
    });

  it.each([{ timeoutSec: Number.MAX_VALUE }, { timeoutMs: Number.MAX_VALUE }])
    ("does not turn an overflowing delay into an immediate timeout: %j", async (config) => {
      await withEndpoint(delayedResponse(50), async (url) => {
        expect(await execute(executionContext(url, config)))
          .toMatchObject({ timedOut: false, exitCode: 0 });
      });
    });

  it.each([200, 503])("clears its deadline when the response is HTTP %s", async (status) => {
    // Fake time isolates the adapter's owned deadline from fetch's internal timers.
    // Actual socket/abort behavior is exercised by the loopback cases above.
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => new Response(null, { status }));
    const pending = execute(executionContext("http://synthetic.test/invoke", { timeoutSec: 3600 }));
    void pending.catch(() => {}); // An early assertion failure must not leave an unhandled rejection.
    expect(vi.getTimerCount()).toBe(1);
    if (status === 200) {
      expect(await pending).toMatchObject({ exitCode: 0, timedOut: false });
    } else {
      await expect(pending).rejects.toThrow("status 503");
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
