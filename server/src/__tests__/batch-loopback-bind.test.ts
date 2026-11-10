import { randomUUID } from "node:crypto";
import http from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { addCompany, addUser } from "./helpers/agent-profile-fixtures.js";
import { startBatchTestApp, type BatchTestApp } from "./helpers/batch-test-app.js";
import { loopbackOriginFor } from "../services/batch/engine.js";

/**
 * Security review fix 2 (eb842442f): batch items are sent to the address the
 * server actually listens on, never an assumed 127.0.0.1. The server here is
 * bound to ::1 only, and another process holds 127.0.0.1 on the same port; it
 * must never receive an item (and its credential), and the item must reach
 * the real server.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("loopbackOriginFor", () => {
  it.each([
    [{ localAddress: "127.0.0.1", localPort: 3100 }, "http://127.0.0.1:3100"],
    [{ localAddress: "::ffff:127.0.0.1", localPort: 3100 }, "http://127.0.0.1:3100"],
    [{ localAddress: "100.83.51.51", localPort: 3100 }, "http://100.83.51.51:3100"],
    [{ localAddress: "::1", localPort: 3100 }, "http://[::1]:3100"],
    [{ localAddress: "fd7a:115c:a1e0::1", localPort: 443, encrypted: true }, "https://[fd7a:115c:a1e0::1]:443"],
    [{ localAddress: "0.0.0.0", localPort: 3100 }, "http://127.0.0.1:3100"],
    [{ localAddress: "::", localPort: 3100 }, "http://[::1]:3100"],
  ])("%j → %s", (socket, origin) => {
    expect(loopbackOriginFor(socket)).toBe(origin);
  });

  it("refuses a link-local address with a zone id plainly, instead of building an invalid URL", () => {
    expect(() => loopbackOriginFor({ localAddress: "fe80::1%en0", localPort: 3100 })).toThrow(/link-local network address/);
  });

  it("refuses when the listener address is unknown", () => {
    expect(() => loopbackOriginFor({ localPort: 3100 })).toThrow();
    expect(() => loopbackOriginFor(undefined)).toThrow();
  });
});

describeEmbeddedPostgres("batch items go to the address the server listens on", () => {
  let t!: BatchTestApp;
  let squatter: http.Server | null = null;
  const squatted: Array<{ authorization: boolean; url: string }> = [];

  beforeAll(async () => {
    t = await startBatchTestApp("paperclip-batch-bind-", {}, { host: "::1" });
    const port = (t.server.address() as { port: number }).port;
    squatter = http.createServer((req, res) => {
      squatted.push({ authorization: Boolean(req.headers.authorization), url: req.url ?? "" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      squatter!.once("error", reject);
      squatter!.listen(port, "127.0.0.1", resolve);
    });
  }, 120_000);

  afterAll(async () => {
    if (squatter) {
      squatter.closeAllConnections();
      await new Promise<void>((resolve) => squatter!.close(() => resolve()));
    }
    await t?.close();
  });

  it("an item reaches the real server on ::1 and nothing reaches the process on 127.0.0.1", async () => {
    const companyId = (await addCompany(t.db, "Bind", "default")).id;
    const userId = await addUser(t.db, companyId, "member");
    const headers = t.browser(await t.signIn(userId));
    const widget = { id: randomUUID(), companyId, value: "old", mode: "ok" as const };
    t.widgets.set(widget.id, widget);
    const p = await request(t.baseUrl).post(`/api/companies/${companyId}/batches/preview`).set(headers)
      .send({ kind: "test.widget", ids: [widget.id], change: { value: "new" } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const c = await request(t.baseUrl).post(`/api/companies/${companyId}/batches/${p.body.batchId}/confirm`).set(headers)
      .send({ handle: p.body.confirmHandle, previewDigest: p.body.previewDigest });
    expect(c.status).toBe(202);
    await t.batches.waitForRunner(p.body.batchId);
    const read = await request(t.baseUrl).get(`/api/companies/${companyId}/batches/${p.body.batchId}`).set(headers);
    expect(squatted).toEqual([]);
    expect(read.body.items[0]).toMatchObject({ outcome: "applied", reasonCode: null });
    expect(t.widgets.get(widget.id)!.value).toBe("new");
  });
});
