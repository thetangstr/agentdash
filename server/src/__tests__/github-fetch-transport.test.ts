// AgentDash: GH #709 — the real ghFetch transport connects to the validated IP,
// keeps the hostname for SNI/Host, and never disables certificate checks.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured: Array<Record<string, unknown>> = [];

function fakeRequest(options: Record<string, unknown>, onResponse: (res: unknown) => void) {
  captured.push(options);
  const req = new EventEmitter() as EventEmitter & { write: (b: string) => void; end: () => void };
  req.write = () => {};
  req.end = () => {
    const res = Object.assign(new PassThrough(), {
      statusCode: 200,
      statusMessage: "OK",
      headers: { "content-type": "text/plain" },
    });
    queueMicrotask(() => {
      onResponse(res);
      res.end("hello");
    });
  };
  return req;
}

vi.mock("node:https", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:https")>()),
  request: vi.fn(fakeRequest),
}));
vi.mock("node:http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:http")>()),
  request: vi.fn(fakeRequest),
}));

const { createGitHubFetch } = await import("../services/github-fetch.js");

afterEach(() => {
  captured.length = 0;
});

describe("ghFetch pinned transport", () => {
  it("connects to the validated IP with SNI and Host set to the real hostname", async () => {
    const fetcher = createGitHubFetch({
      lookup: async () => [{ address: "185.199.108.133", family: 4 }],
      env: {},
    });

    const res = await fetcher("https://raw.githubusercontent.com/acme/pkg/main/COMPANY.md?x=1", {
      headers: { accept: "text/plain" },
    });

    expect(await res.text()).toBe("hello");
    expect(captured).toHaveLength(1);
    const options = captured[0]!;
    expect(options.host).toBe("185.199.108.133");
    expect(options.family).toBe(4);
    expect(options.port).toBe(443);
    expect(options.protocol).toBe("https:");
    expect(options.servername).toBe("raw.githubusercontent.com");
    expect(options.path).toBe("/acme/pkg/main/COMPANY.md?x=1");
    const headers = options.headers as Record<string, string>;
    expect(headers.host).toBe("raw.githubusercontent.com");
    expect(headers.accept).toBe("text/plain");
    expect(headers["user-agent"]).toBe("AgentDash");
    // Certificate verification is never turned off.
    expect(options.rejectUnauthorized).not.toBe(false);
    expect("rejectUnauthorized" in options ? options.rejectUnauthorized : true).toBe(true);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not re-resolve the hostname: the connection target is the IP, not the name", async () => {
    const lookup = vi.fn(async () => [{ address: "140.82.112.3", family: 4 }]);
    const fetcher = createGitHubFetch({ lookup, env: {} });

    await fetcher("https://api.github.com/repos/acme/pkg");

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(captured[0]!.host).toBe("140.82.112.3");
    expect(captured[0]!.lookup).toBeUndefined();
  });
});
