import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute as executeHttp } from "../adapters/http/execute.js";
import { execute as executeProcess } from "../adapters/process/execute.js";

const openServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string }> {
  const server = createServer(handler);
  openServers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to listen on a local HTTP port"));
        return;
      }
      resolve({ url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("process adapter", () => {
  it("injects run env and reports spawned process metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-adapter-"));
    const capturePath = path.join(root, "env.json");

    try {
      const spawned: Array<{ pid: number; processGroupId: number | null; startedAt: string }> = [];
      const result = await executeProcess({
        runId: "run-process-1",
        agent: {
          id: "agent-process-1",
          companyId: "company-1",
          name: "Process Agent",
          adapterType: "process",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: process.execPath,
          args: [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ runId: process.env.PAPERCLIP_RUN_ID, agentId: process.env.PAPERCLIP_AGENT_ID }))`,
          ],
          cwd: root,
        },
        context: {},
        onLog: async () => {},
        onSpawn: async (meta) => {
          spawned.push(meta);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeUndefined();
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.pid).toEqual(expect.any(Number));
      expect(spawned[0]?.startedAt).toEqual(expect.any(String));
      await expect(fs.readFile(capturePath, "utf8")).resolves.toBe(
        JSON.stringify({ runId: "run-process-1", agentId: "agent-process-1" }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("http adapter", () => {
  it("posts the configured payload plus agent, run, and context data", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedHeader = "";
    const { url } = await listen(async (req, res) => {
      capturedHeader = String(req.headers["x-paperclip-test"] ?? "");
      capturedBody = JSON.parse(await readBody(req)) as Record<string, unknown>;
      res.writeHead(204);
      res.end();
    });

    const metaCommands: string[] = [];
    const result = await executeHttp({
      runId: "run-http-1",
      agent: {
        id: "agent-http-1",
        companyId: "company-1",
        name: "HTTP Agent",
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
        url,
        method: "post",
        headers: { "x-paperclip-test": "yes" },
        payloadTemplate: { kind: "wake" },
      },
      context: { issueId: "issue-1" },
      onLog: async () => {},
      onMeta: async (meta) => {
        metaCommands.push(meta.command);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe(`HTTP POST ${url}`);
    expect(capturedHeader).toBe("yes");
    expect(capturedBody).toMatchObject({
      kind: "wake",
      agentId: "agent-http-1",
      runId: "run-http-1",
      context: { issueId: "issue-1" },
    });
    expect(metaCommands).toEqual([`POST ${url}`]);
  });

  it("returns a structured failure for non-success responses", async () => {
    const { url } = await listen((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("temporarily down");
    });

    const result = await executeHttp({
      runId: "run-http-2",
      agent: {
        id: "agent-http-1",
        companyId: "company-1",
        name: "HTTP Agent",
        adapterType: "http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { url },
      context: {},
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("http_status");
    expect(result.errorMessage).toContain("status 503");
    expect(result.resultJson).toMatchObject({
      status: 503,
      body: "temporarily down",
    });
  });

  it("honors timeoutSec when timeoutMs is not configured", async () => {
    const { url } = await listen((_req, res) => {
      setTimeout(() => {
        res.writeHead(204);
        res.end();
      }, 100);
    });

    const result = await executeHttp({
      runId: "run-http-3",
      agent: {
        id: "agent-http-1",
        companyId: "company-1",
        name: "HTTP Agent",
        adapterType: "http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { url, timeoutSec: 0.01 },
      context: {},
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 10ms");
  });
});
