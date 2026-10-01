// AgentDash (GH #733): the box's off-box backup export route.
//   - inert without AGENTDASH_BACKUP_TOKEN (or with a short one);
//   - POST only; a missing or wrong bearer is 401 and runs nothing;
//   - the right bearer streams the dump with its format, counts and release
//     headers, and the dump is removed afterwards;
//   - one export at a time (409);
//   - a failed export is a 500 that names nothing, and still cleans up;
//   - the token never reaches a later handler.
// The control plane's round-trip test (cloud/src/__tests__/backups.test.ts)
// drives this same route against a real dump and restores it.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKUP_COUNTS_HEADER,
  BACKUP_EXPORT_FORMAT,
  BACKUP_EXPORT_PATH,
  backupExportRoutes,
  backupTokenMatches,
  collectBackupCounts,
  configuredBackupToken,
  type BackupExportService,
} from "../routes/agentdash-backup-export.js";

const TOKEN = "t".repeat(64);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeService(opts: { fail?: boolean; gate?: Promise<void> } = {}) {
  const calls = { run: 0, cleaned: 0 };
  const service: BackupExportService = {
    async run() {
      calls.run++;
      if (opts.gate) await opts.gate;
      if (opts.fail) throw new Error("pg connection to postgres://user:pw@db/x refused");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-test-"));
      dirs.push(dir);
      const file = path.join(dir, "dump.sql.gz");
      fs.writeFileSync(file, Buffer.from("fake gz bytes"));
      return {
        file,
        counts: { users: 2, migrations: 140 },
        cleanup: async () => {
          calls.cleaned++;
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  };
  return { service, calls };
}

function app(token: string | null, service?: BackupExportService, timeoutMs?: number) {
  const a = express();
  a.use(backupExportRoutes({ token, service, release: "v2026.1001.0", timeoutMs }));
  a.all("/{*rest}", (req, res) => res.status(404).json({ sawAuthorization: "authorization" in req.headers }));
  return a;
}

describe("backup export route", () => {
  it("does not exist without a (long enough) token", async () => {
    expect(configuredBackupToken({})).toBeNull();
    expect(configuredBackupToken({ AGENTDASH_BACKUP_TOKEN: "short" })).toBeNull();
    expect(configuredBackupToken({ AGENTDASH_BACKUP_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
    const { service, calls } = fakeService();
    const res = await request(app(null, service)).post(BACKUP_EXPORT_PATH).set("authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(404);
    expect(calls.run).toBe(0);
  });

  it("refuses a missing or wrong token without running anything, and other methods", async () => {
    const { service, calls } = fakeService();
    const a = app(TOKEN, service);
    expect((await request(a).post(BACKUP_EXPORT_PATH)).status).toBe(401);
    expect((await request(a).post(BACKUP_EXPORT_PATH).set("authorization", `Bearer ${TOKEN.slice(1)}x`)).status).toBe(401);
    expect((await request(a).post(BACKUP_EXPORT_PATH).set("authorization", TOKEN)).status).toBe(401);
    expect((await request(a).get(BACKUP_EXPORT_PATH).set("authorization", `Bearer ${TOKEN}`)).status).toBe(405);
    expect(calls.run).toBe(0);
    expect(backupTokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("streams the dump with its headers and cleans up", async () => {
    const { service, calls } = fakeService();
    const res = await request(app(TOKEN, service)).post(BACKUP_EXPORT_PATH).set("authorization", `Bearer ${TOKEN}`).buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on("data", (c: Buffer) => parts.push(c));
      r.on("end", () => cb(null, Buffer.concat(parts)));
    });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe("fake gz bytes");
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["x-agentdash-backup-format"]).toBe(BACKUP_EXPORT_FORMAT);
    expect(JSON.parse(res.headers[BACKUP_COUNTS_HEADER]!)).toEqual({ users: 2, migrations: 140 });
    expect(res.headers["x-agentdash-backup-release"]).toBe("v2026.1001.0");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.cleaned).toBe(1);
  });

  it("runs one export at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service } = fakeService({ gate });
    const a = app(TOKEN, service);
    const first = request(a).post(BACKUP_EXPORT_PATH).set("authorization", `Bearer ${TOKEN}`).then((r) => r);
    await new Promise((r) => setTimeout(r, 30));
    expect((await request(a).post(BACKUP_EXPORT_PATH).set("authorization", `Bearer ${TOKEN}`)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect((await request(a).post(BACKUP_EXPORT_PATH).set("authorization", `Bearer ${TOKEN}`)).status).toBe(200);
  });

  it("a caller that hangs up mid-dump leaks no file and does not leave the next export on 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service, calls } = fakeService({ gate });
    const server = http.createServer(app(TOKEN, service));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      // Start an export, then drop the connection while the dump is still running.
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: BACKUP_EXPORT_PATH, headers: { authorization: `Bearer ${TOKEN}` } });
      req.on("error", () => {});
      req.end();
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.run).toBe(1);
      req.destroy();
      await new Promise((r) => setTimeout(r, 50));
      // The dump finishes after the caller left: it is removed, and the slot is freed.
      release();
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.cleaned).toBe(1);
      expect(dirs.every((d) => !fs.existsSync(d))).toBe(true);
      const next = await fetch(`http://127.0.0.1:${port}${BACKUP_EXPORT_PATH}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      expect(next.status).toBe(200);
      await next.arrayBuffer();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("a dump that runs past the hard timeout answers 504, frees the slot, and is removed when it ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeService({ gate });
    const a = app(TOKEN, slow.service, 50);
    const res = await request(a).post(BACKUP_EXPORT_PATH).set("authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(504);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(slow.calls.cleaned).toBe(1);
  });

  it("a failed export answers 500 without details and frees the slot", async () => {
    const { service } = fakeService({ fail: true });
    const a = app(TOKEN, service);
    const res = await request(a).post(BACKUP_EXPORT_PATH).set("authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/postgres|pw/);
    expect((await request(a).post(BACKUP_EXPORT_PATH).set("authorization", `Bearer ${TOKEN}`)).status).toBe(500);
  });

  it("passes other paths through untouched", async () => {
    const { service } = fakeService();
    const res = await request(app(TOKEN, service)).get("/api/health").set("authorization", "Bearer something");
    expect(res.status).toBe(404);
    expect(res.body.sawAuthorization).toBe(true);
  });

  it("counts the core tables, reporting missing ones as null", async () => {
    const seen: string[] = [];
    const counts = await collectBackupCounts(async (text) => {
      seen.push(text);
      if (text.includes("to_regclass")) return [{ present: !text.includes("company_memberships") }];
      return [{ n: 3 }];
    });
    expect(counts).toEqual({ companies: 3, users: 3, agents: 3, issues: 3, memberships: null, migrations: 3 });
    expect(seen.some((t) => t.includes('"user"'))).toBe(true);
  });
});
