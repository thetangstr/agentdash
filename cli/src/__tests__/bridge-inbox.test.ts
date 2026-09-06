import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  renderInbox,
  runBridgeInbox,
  scaffoldInboxWorkspace,
} from "../commands/bridge-inbox.js";

let scratch: string;
let tokenFile: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "inbox-"));
  tokenFile = path.join(scratch, "token");
  writeFileSync(tokenFile, "endpoint-token", { mode: 0o600 });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-03T12:00:00.000Z");

function digest(overrides: Record<string, unknown> = {}) {
  return {
    lastAckedSeq: 0,
    headSeq: 2,
    hasMore: false,
    events: [
      { seq: 1, kind: "approval.opened", refType: "approval", refId: "a1", payload: {}, createdAt: "2026-09-03T11:00:00.000Z" },
      { seq: 2, kind: "approval.opened", refType: "approval", refId: "a2", payload: {}, createdAt: "2026-09-03T11:30:00.000Z" },
    ],
    digest: {
      agentsAnsweredFor: 2,
      approvals: {
        total: 1,
        shown: 1,
        items: [
          {
            approvalId: "a1",
            type: "connector_send",
            revision: 2,
            agentName: "Casper",
            risk: { level: "high", reason: "Destructive action" },
            waitingSince: "2026-09-03T09:00:00.000Z",
          },
        ],
      },
      blockers: { total: 14, shown: 2, items: [
        { identifier: "MK-1", title: "Waiting on a rate", agentName: "Casper" },
        { identifier: null, title: "Needs a decision", agentName: null },
      ] },
      completions: { total: 3, shown: 3, items: [
        { identifier: "MK-9", title: "Drafted the note", agentName: "Scout" },
        { identifier: "MK-8", title: "Filed the summary", agentName: "Scout" },
        { identifier: "MK-7", title: "Checked the figures", agentName: "Emilia" },
      ] },
      truncated: true,
    },
    ...overrides,
  };
}

function makeFetch(handlers: {
  sync?: () => { ok: boolean; status?: number; body?: unknown };
  ack?: () => { ok: boolean; status?: number };
}) {
  const calls: Array<{ path: string; body: Record<string, unknown>; auth?: string }> = [];
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path: url.pathname, body, auth: headers.authorization });
    if (url.pathname.endsWith("/inbox/sync")) {
      const reply = handlers.sync?.() ?? { ok: true, body: digest() };
      return {
        ok: reply.ok,
        status: reply.status ?? (reply.ok ? 200 : 500),
        json: async () => reply.body,
        text: async () => JSON.stringify(reply.body ?? {}),
      } as unknown as Response;
    }
    const reply = handlers.ack?.() ?? { ok: true };
    return {
      ok: reply.ok,
      status: reply.status ?? (reply.ok ? 200 : 500),
      json: async () => ({}),
      text: async () => "",
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("bridge inbox rendering", () => {
  it("reads urgent approvals, then blockers, then completions", () => {
    const text = renderInbox(digest() as never, NOW);
    const order = ["Waiting on your decision", "Stopped and needs you", "Finished"].map((h) =>
      text.indexOf(h),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  /** A shown list that hides its total lies about how much is waiting. */
  it("says how much it did not show", () => {
    const text = renderInbox(digest() as never, NOW);
    expect(text).toContain("Stopped and needs you (14)");
    expect(text).toContain("… and 12 more (14 in total)");
    // Nothing hidden in completions, so nothing claimed.
    expect(text).not.toContain("more (3 in total)");
  });

  it("carries the ask and points elsewhere for the evidence", () => {
    const text = renderInbox(digest() as never, NOW);
    expect(text).toContain("nothing above carries the evidence");
    expect(text).toContain("Casper");
    expect(text).toContain("high: Destructive action");
  });

  it("says so plainly when nothing is waiting", () => {
    const quiet = digest({
      events: [],
      digest: {
        agentsAnsweredFor: 1,
        approvals: { total: 0, shown: 0, items: [] },
        blockers: { total: 0, shown: 0, items: [] },
        completions: { total: 0, shown: 0, items: [] },
        truncated: false,
      },
    });
    expect(renderInbox(quiet as never, NOW)).toBe("AgentDash inbox: nothing waiting on you.");
  });
});

describe("bridge inbox command", () => {
  /**
   * The property that matters most. A SessionStart hook exiting 2 stops the
   * session from starting at all, so an unreachable inbox must never be able to
   * stop a steward from working.
   */
  it("never exits 2, whatever goes wrong", async () => {
    const cases: Array<() => Promise<number>> = [
      // no credential at all
      () => runBridgeInbox({}, { env: {}, log: () => {}, errorLog: () => {} }),
      // server refuses
      () =>
        runBridgeInbox(
          { server: "http://x.test", tokenFile },
          {
            env: {},
            log: () => {},
            errorLog: () => {},
            fetchImpl: makeFetch({ sync: () => ({ ok: false, status: 403, body: { error: "no" } }) }).impl,
          },
        ),
      // network dies
      () =>
        runBridgeInbox(
          { server: "http://x.test", tokenFile },
          {
            env: {},
            log: () => {},
            errorLog: () => {},
            fetchImpl: (() => {
              throw new Error("ECONNREFUSED");
            }) as unknown as typeof fetch,
          },
        ),
      // nonsense limit
      () =>
        runBridgeInbox(
          { server: "http://x.test", tokenFile, limit: "0" },
          { env: {}, log: () => {}, errorLog: () => {} },
        ),
    ];
    for (const run of cases) {
      const code = await run();
      expect(code).not.toBe(2);
      expect(code).toBe(1);
    }
  });

  it("prints nothing at all when asked to stay quiet and nothing is waiting", async () => {
    const lines: string[] = [];
    const quiet = digest({
      events: [],
      digest: {
        agentsAnsweredFor: 1,
        approvals: { total: 0, shown: 0, items: [] },
        blockers: { total: 0, shown: 0, items: [] },
        completions: { total: 0, shown: 0, items: [] },
        truncated: false,
      },
    });
    const code = await runBridgeInbox(
      { server: "http://x.test", tokenFile, quietWhenEmpty: true },
      {
        env: {},
        log: (line) => lines.push(line),
        errorLog: () => {},
        fetchImpl: makeFetch({ sync: () => ({ ok: true, body: quiet }) }).impl,
      },
    );
    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });

  it("asks for the digest and sends the endpoint token as a bearer", async () => {
    const fetchMock = makeFetch({});
    await runBridgeInbox(
      { server: "http://x.test/", tokenFile },
      { env: {}, log: () => {}, errorLog: () => {}, fetchImpl: fetchMock.impl },
    );
    const sync = fetchMock.calls.find((c) => c.path.endsWith("/inbox/sync"))!;
    expect(sync.body.includeDigest).toBe(true);
    expect(sync.auth).toBe("Bearer endpoint-token");
  });

  it("acknowledges only the highest position it actually showed", async () => {
    const fetchMock = makeFetch({});
    await runBridgeInbox(
      { server: "http://x.test", tokenFile, ack: true },
      { env: {}, log: () => {}, errorLog: () => {}, fetchImpl: fetchMock.impl },
    );
    const ack = fetchMock.calls.find((c) => c.path.endsWith("/inbox/ack"));
    expect(ack?.body.seq).toBe(2);
  });

  it("does not acknowledge when there was nothing to show", async () => {
    const fetchMock = makeFetch({ sync: () => ({ ok: true, body: digest({ events: [] }) }) });
    await runBridgeInbox(
      { server: "http://x.test", tokenFile, ack: true },
      { env: {}, log: () => {}, errorLog: () => {}, fetchImpl: fetchMock.impl },
    );
    expect(fetchMock.calls.some((c) => c.path.endsWith("/inbox/ack"))).toBe(false);
  });

  /**
   * At-least-once delivery is the whole design: a failed acknowledgement means
   * the same items come back next time, which is correct and not an error.
   */
  it("still succeeds when the acknowledgement fails", async () => {
    const errors: string[] = [];
    const code = await runBridgeInbox(
      { server: "http://x.test", tokenFile, ack: true },
      {
        env: {},
        log: () => {},
        errorLog: (line) => errors.push(line),
        fetchImpl: makeFetch({ ack: () => ({ ok: false, status: 500 }) }).impl,
      },
    );
    expect(code).toBe(0);
    expect(errors.join(" ")).toContain("Could not acknowledge");
  });

  it("refuses a token on the command line by never offering the option", () => {
    const source = readFileSync(
      new URL("../commands/bridge-inbox.ts", import.meta.url),
      "utf8",
    );
    // Handles and endpoint tokens are credentials; argv is world-readable.
    expect(source).not.toMatch(/\.option\("--token </);
    expect(source).not.toMatch(/\.option\("--handle </);
  });
});

describe("inbox workspace scaffold", () => {
  it("writes a SessionStart hook that catches up on startup and resume", () => {
    const dir = path.join(scratch, "wk");
    const { created } = scaffoldInboxWorkspace(dir, { server: "https://mk.test" });
    expect(created).toContain(path.join(dir, ".claude", "settings.json"));

    const settings = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    const entry = settings.hooks.SessionStart[0];
    expect(entry.matcher).toBe("startup|resume");
    expect(entry.hooks[0].type).toBe("command");
    expect(entry.hooks[0].command).toContain("bridge inbox");
    expect(entry.hooks[0].command).toContain("--quiet-when-empty");
    expect(entry.hooks[0].command).toContain("--server https://mk.test");
  });

  /**
   * The "never interrupt a coding session" rule is enforced by WHERE the hook
   * lives, so the scaffold must put it in the project, never in the user's
   * global settings.
   */
  it("keeps the hook local to the workspace it creates", () => {
    const dir = path.join(scratch, "local");
    scaffoldInboxWorkspace(dir);
    expect(existsSync(path.join(dir, ".claude", "settings.json"))).toBe(true);
    const readme = readFileSync(path.join(dir, "README.md"), "utf8");
    expect(readme).toContain("applies only to sessions started here");
  });

  it("never clobbers settings that are already there", () => {
    const dir = path.join(scratch, "existing");
    scaffoldInboxWorkspace(dir);
    writeFileSync(path.join(dir, ".claude", "settings.json"), '{"mine":true}');
    const { created, skipped } = scaffoldInboxWorkspace(dir);
    expect(created).toEqual([]);
    expect(skipped).toContain(path.join(dir, ".claude", "settings.json"));
    expect(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")).toBe('{"mine":true}');
  });
});
