import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderInbox,
  resolveBridgeToken,
  resolveInboxServer,
  runInbox,
  scaffoldInboxWorkspace,
  storeBridgeToken,
  unseenApprovalCount,
} from "./inbox.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "inbox-test-"));

const NOW = Date.parse("2026-09-14T12:00:00Z");
const digest = (over = {}) => ({
  agentsAnsweredFor: 1,
  approvals: { total: 0, shown: 0, items: [] },
  blockers: { total: 0, shown: 0, items: [] },
  completions: { total: 0, shown: 0, items: [] },
  truncated: false,
  ...over,
});

describe("renderInbox", () => {
  it("says plainly when nothing is waiting", () => {
    expect(renderInbox({ events: [], digest: digest() }, NOW)).toBe(
      "AgentDash inbox: nothing waiting on you.",
    );
  });

  /**
   * The order is the contract, mirrored from cli/src/commands/bridge-inbox.ts:
   * decisions being blocked on, then agents that stopped, then what finished.
   * Two clients teaching two orders would make the inbox mean different things
   * depending on which laptop reads it.
   */
  it("renders decisions, then blockers, then completions", () => {
    const text = renderInbox(
      {
        events: [],
        digest: digest({
          approvals: {
            total: 1,
            shown: 1,
            items: [
              {
                approvalId: "a1",
                type: "purchase",
                revision: 3,
                agentName: "HAL",
                risk: { level: "high", reason: "exceeds the $25 limit" },
                waitingSince: "2026-09-14T09:00:00Z",
              },
            ],
          },
          blockers: { total: 1, shown: 1, items: [{ identifier: "MKT-49", title: "Draft note", agentName: "HAL" }] },
          completions: { total: 1, shown: 1, items: [{ identifier: "MKT-47", title: "Health check", agentName: "HAL" }] },
        }),
      },
      NOW,
    );
    const decision = text.indexOf("Waiting on your decision (1):");
    const blocked = text.indexOf("Stopped and needs you (1):");
    const finished = text.indexOf("Finished (1):");
    expect(decision).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(blocked);
    expect(blocked).toBeLessThan(finished);
    expect(text).toContain("HAL — purchase [high: exceeds the $25 limit], rev 3, waiting 3h");
    expect(text).toContain("Decide with the inbox_decide tool.");
  });

  /**
   * `--ack` advances over the whole fetched page, so an approval decided
   * elsewhere would be buried without ever being rendered. It is counted and
   * named instead — never silently.
   */
  it("names approvals on the page that were already decided elsewhere", () => {
    const response = {
      events: [{ seq: 4, kind: "approval.opened", refType: "approval", refId: "gone", payload: {}, createdAt: "" }],
      digest: digest(),
    };
    expect(unseenApprovalCount(response)).toBe(1);
    expect(renderInbox(response, NOW)).toContain("1 other update(s) already dealt with");
  });
});

describe("storeBridgeToken", () => {
  it("writes the credential at mode 600, even over an existing looser file", () => {
    const dir = tmp();
    const target = path.join(dir, "bridge-token");
    writeFileSync(target, "old", { mode: 0o644 });
    storeBridgeToken("bt_secret", target);
    expect(readFileSync(target, "utf8")).toBe("bt_secret");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe("scaffoldInboxWorkspace", () => {
  /**
   * The hook must run this package, not `paperclipai`: the machine being
   * connected has npx and nothing else, and a hook that says "command not
   * found" is a flow that ends on exactly the laptops it was written for.
   */
  it("installs a SessionStart hook that needs only npx", () => {
    const dir = tmp();
    const { created } = scaffoldInboxWorkspace(dir, { server: "https://mk.example:3112" });
    expect(created).toHaveLength(2);
    const settings = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    const hook = settings.hooks.SessionStart[0];
    expect(hook.matcher).toBe("startup|resume");
    const command = hook.hooks[0].command;
    expect(command).toContain("npx -y agentdash-connect inbox");
    expect(command).toContain("--ack --quiet-when-empty");
    expect(command).toContain("--server https://mk.example:3112");
    expect(command).not.toContain("paperclipai");
  });

  it("keeps existing files rather than clobbering somebody's edits", () => {
    const dir = tmp();
    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    writeFileSync(path.join(dir, ".claude", "settings.json"), "{}");
    const { created, skipped } = scaffoldInboxWorkspace(dir, {});
    expect(skipped).toContain(path.join(dir, ".claude", "settings.json"));
    expect(created).toHaveLength(1); // only the README
    expect(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")).toBe("{}");
  });
});

describe("resolveInboxServer", () => {
  it("recovers the instance from the MCP config the connect flow wrote", () => {
    const dir = tmp();
    const configPath = path.join(dir, ".claude.json");
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { agentdash: { url: "https://mk.example:3112/api/mcp" } } }),
    );
    expect(resolveInboxServer({ env: {}, claudeConfigPath: configPath })).toBe("https://mk.example:3112");
  });

  it("prefers an explicit --server and strips a pasted /api", () => {
    expect(resolveInboxServer({ server: "https://mk.example:3112/api/", env: {} })).toBe(
      "https://mk.example:3112",
    );
  });
});

describe("runInbox", () => {
  const deps = (fetchImpl) => {
    const logs = [];
    const errors = [];
    return {
      impl: { fetchImpl, log: (l) => logs.push(l), errorLog: (l) => errors.push(l), now: () => NOW },
      logs,
      errors,
    };
  };
  const opts = (dir) => {
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, "bt_x");
    return { server: "https://mk.example:3112", tokenFile };
  };

  /**
   * Exit 1, never 2 — inherited from the CLI this mirrors. A SessionStart hook
   * that exits 2 stops the session from starting, and an unreachable inbox must
   * never be able to stop a steward from working.
   */
  it("fails soft when the instance is unreachable", async () => {
    const { impl, errors } = deps(async () => {
      throw new Error("ECONNREFUSED");
    });
    const code = await runInbox(opts(tmp()), impl);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("unreachable");
  });

  it("renders the digest and acknowledges the highest seq shown", async () => {
    const calls = [];
    const { impl, logs } = deps(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith("/inbox/sync")) {
        return {
          ok: true,
          json: async () => ({
            lastAckedSeq: 0,
            headSeq: 7,
            hasMore: false,
            events: [
              { seq: 6, kind: "approval.opened", refType: "approval", refId: "a1", payload: {}, createdAt: "" },
              { seq: 7, kind: "approval.opened", refType: "approval", refId: "a2", payload: {}, createdAt: "" },
            ],
            digest: digest({
              approvals: {
                total: 2,
                shown: 2,
                items: [
                  { approvalId: "a1", type: "purchase", revision: 1, agentName: "HAL", risk: { level: "high", reason: "limit" }, waitingSince: "2026-09-14T11:00:00Z" },
                  { approvalId: "a2", type: "external_contact", revision: 1, agentName: "Casper", risk: { level: "medium", reason: "outside" }, waitingSince: "2026-09-14T11:30:00Z" },
                ],
              },
            }),
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const code = await runInbox({ ...opts(tmp()), ack: true }, impl);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Waiting on your decision (2):");
    const ack = calls.find((c) => c.url.endsWith("/inbox/ack"));
    expect(ack?.body.seq).toBe(7);
  });

  it("prints nothing when empty and told to be quiet", async () => {
    const { impl, logs } = deps(async () => ({
      ok: true,
      json: async () => ({ lastAckedSeq: 0, headSeq: 0, hasMore: false, events: [], digest: digest() }),
    }));
    const code = await runInbox({ ...opts(tmp()), quietWhenEmpty: true }, impl);
    expect(code).toBe(0);
    expect(logs).toHaveLength(0);
  });
});
