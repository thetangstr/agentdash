import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, serverErrors } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  fingerprintError,
  initErrorSink,
  recordServerError,
  resetErrorSinkForTest,
} from "../observability/error-sink.js";
import {
  resetSignalSubscribersForTest,
  subscribeToSignals,
  type Signal,
} from "../observability/signals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * The sink replaced a remote transport that was measured to drop every event
 * (`if (!target) return` with nothing ever configured). These tests hold the
 * properties that made that bug invisible: writes must actually land, and the
 * sink must never throw into the code path that noticed the problem.
 */
describeEmbeddedPostgres("error sink", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-error-sink-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    resetSignalSubscribersForTest();
    initErrorSink(db);
  });

  afterEach(async () => {
    resetErrorSinkForTest();
    await db.delete(serverErrors);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function flushSink() {
    // recordServerError is deliberately fire-and-forget; give the insert a beat.
    for (let i = 0; i < 20; i++) {
      const rows = await db.select().from(serverErrors);
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return db.select().from(serverErrors);
  }

  it("persists an error to Postgres — read back, not trusted", async () => {
    recordServerError(new Error("issue 12345 exploded"), {
      method: "POST",
      url: "/api/issues/12345",
      status: 500,
    });

    const rows = await flushSink();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("issue 12345 exploded");
    expect(rows[0].count).toBe(1);
    expect(rows[0].lastContext).toMatchObject({ method: "POST", status: 500 });
  });

  it("counts repeats of the same defect as ONE row — ids stripped", async () => {
    // The disk-fill property: an error loop overnight must not create one
    // row per occurrence, and differing entity ids must not defeat grouping.
    recordServerError(new Error("project 1111 not found"));
    await flushSink();
    recordServerError(new Error("project 2222 not found"));
    for (let i = 0; i < 20; i++) {
      const rows = await db.select().from(serverErrors);
      if (rows[0]?.count === 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const rows = await db.select().from(serverErrors);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
  });

  it("distinct defects get distinct rows", async () => {
    recordServerError(new TypeError("cannot read x of undefined"));
    await flushSink();
    recordServerError(new Error("connection refused"));
    for (let i = 0; i < 20; i++) {
      if ((await db.select().from(serverErrors)).length === 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await db.select().from(serverErrors)).toHaveLength(2);
  });

  it("emits a server_error signal with the fingerprint, and no request body slot exists", async () => {
    const seen: Signal[] = [];
    subscribeToSignals((s) => void seen.push(s));

    recordServerError(new Error("boom"), { method: "GET", url: "/api/x", status: 500 });
    await flushSink();
    for (let i = 0; i < 20 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("server_error");
    expect(seen[0].detail?.fingerprint).toBeTruthy();
    // The context type has no body field; assert the emitted detail carries
    // only the whitelisted shape.
    expect(Object.keys(seen[0].detail ?? {}).sort()).toEqual(
      ["fingerprint", "method", "status", "url"].sort(),
    );
  });

  it("never throws when the sink is uninitialised — stderr is the fallback", () => {
    resetErrorSinkForTest();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => recordServerError(new Error("early crash"))).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("fingerprints are stable across ids and line numbers, distinct across defects", () => {
    const a = fingerprintError("Error", "project 7f3a9b2c-0000-4000-8000-123456789abc not found");
    const b = fingerprintError("Error", "project 00000000-1111-4222-8333-abcdefabcdef not found");
    const c = fingerprintError("Error", "agent not found");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
