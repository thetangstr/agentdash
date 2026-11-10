import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sendBatchItemOverLoopback } from "../services/batch/runner.js";

/**
 * AgentDash admin powers, part 2: the loopback client keeps "never sent"
 * (nothing can have changed: failed) apart from "sent, no answer" (it may
 * have landed: unknown, never retried).
 */

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const send = (url: string, timeoutMs = 2000) =>
  sendBatchItemOverLoopback({ url, method: "PATCH", headers: { "content-type": "application/json" }, body: '{"a":1}', timeoutMs });

describe("sendBatchItemOverLoopback", () => {
  it("returns the status and JSON body of an answer", async () => {
    const base = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "locked", echo: body })); });
    });
    expect(await send(`${base}/x`)).toEqual({ kind: "response", status: 409, body: { error: "locked", echo: '{"a":1}' } });
  });

  it("a refused connection was never sent", async () => {
    const base = await listen(() => undefined);
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect((await send(`${base}/x`)).kind).toBe("not_sent");
  });

  it("a connection dropped after the request was sent is no answer", async () => {
    const base = await listen((req) => { req.on("data", () => undefined); req.on("end", () => req.socket.destroy()); });
    expect((await send(`${base}/x`)).kind).toBe("no_answer");
  });

  it("a request with no answer before the timeout is no answer", async () => {
    const base = await listen(() => undefined);
    const result = await send(`${base}/x`, 200);
    expect(result).toEqual({ kind: "no_answer", error: "timeout" });
  });
});
