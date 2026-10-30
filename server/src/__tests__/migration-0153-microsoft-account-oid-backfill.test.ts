import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authAccounts, authUsers, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";

/**
 * Migration 0153 (Better Auth 1.6 -> 1.7): Microsoft sign-in accounts move
 * from the ID token's `sub` to its `oid`, read from the row's own stored
 * id_token. Run against a real Postgres: the base64url/jsonb decoding, the
 * conflict rules and the notices are the properties at stake, and the last
 * test drives a real Better Auth 1.7 instance through the id-token sign-in.
 */

function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

vi.mock("../auth/social-providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/social-providers.js")>();
  return {
    ...actual,
    // The real Microsoft provider config, with the token check stubbed: the
    // test's unsigned token is accepted and its claims are the profile.
    buildSocialProviders: (env?: Record<string, string | undefined>) => {
      const providers = actual.buildSocialProviders(env);
      if (providers.microsoft) {
        providers.microsoft = {
          ...(providers.microsoft as object),
          verifyIdToken: async () => true,
          getUserInfo: async (token: { idToken?: string }) => {
            const claims = decodeClaims(token.idToken!);
            return {
              // Not verified, so Better Auth will not link by email: a
              // successful sign-in can only come from the account key.
              user: { name: "Microsoft Person", email: claims.email as string, emailVerified: false },
              data: claims,
            };
          },
        };
      }
      return providers;
    },
  };
});

import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const MIGRATION = fs.readFileSync(
  fileURLToPath(
    new URL("../../../packages/db/src/migrations/0153_microsoft_account_oid_backfill.sql", import.meta.url),
  ),
  "utf8",
);

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An unsigned JWT-shaped token: the migration reads claims, never the signature. */
function idToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256", typ: "JWT", kid: "test" })}.${b64url(claims)}.c2lnbmF0dXJl`;
}

const TID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const ISS = `https://login.microsoftonline.com/${TID}/v2.0`;

function guid(): string {
  return randomUUID();
}

describeEmbeddedPostgres("migration 0153: Microsoft accounts re-keyed from sub to oid", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "AGENTDASH_DEPLOYMENT_KIND",
    "BETTER_AUTH_SECRET",
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "MICROSOFT_TENANT_ID",
    "PAPERCLIP_PUBLIC_URL",
  ] as const;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-migration-0153-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    delete process.env.MICROSOFT_TENANT_ID;
    delete process.env.PAPERCLIP_PUBLIC_URL;
    process.env.BETTER_AUTH_SECRET = "migration-0153-test-secret-0123456789abcdef";
    process.env.MICROSOFT_CLIENT_ID = "microsoft-client";
    process.env.MICROSOFT_CLIENT_SECRET = "microsoft-secret";
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await truncateWithRetry(db, sql`${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Run the file statement by statement, as the runner does, collecting notices. */
  async function runMigration(): Promise<string[]> {
    const notices: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      for (const arg of args) {
        const message = (arg as { message?: unknown } | null)?.message;
        if (typeof message === "string") notices.push(message);
      }
    });
    try {
      for (const statement of MIGRATION.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
        await db.execute(sql.raw(statement));
      }
    } finally {
      spy.mockRestore();
    }
    return notices;
  }

  async function user(email = `${randomUUID().slice(0, 8)}@example.com`) {
    const now = new Date();
    return db
      .insert(authUsers)
      .values({ id: `user-${randomUUID()}`, name: "Person", email, emailVerified: false, createdAt: now, updatedAt: now })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function account(userId: string, providerId: string, accountId: string, token: string | null) {
    const created = new Date("2026-09-01T00:00:00Z");
    return db
      .insert(authAccounts)
      .values({
        id: `acct-${randomUUID()}`,
        userId,
        providerId,
        accountId,
        idToken: token,
        createdAt: created,
        updatedAt: created,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function allAccounts() {
    return db.select().from(authAccounts).orderBy(asc(authAccounts.id));
  }

  it("re-keys a sub-keyed Microsoft row to its token's oid, leaves every other row unchanged, and a re-run changes nothing", async () => {
    const u = await user();
    const sub = `sub-${randomUUID()}`;
    const oid = guid();
    const migrated = await account(u.id, "microsoft", sub, idToken({ iss: ISS, tid: TID, sub, oid }));

    const alreadySub = `sub-${randomUUID()}`;
    const alreadyOid = guid();
    await account(u.id, "microsoft", alreadyOid, idToken({ sub: alreadySub, oid: alreadyOid }));
    const noToken = await account(u.id, "microsoft", `sub-${randomUUID()}`, null);
    const notAJwt = await account(u.id, "microsoft", `sub-${randomUUID()}`, "not-a-jwt");
    const notJson = await account(u.id, "microsoft", `sub-${randomUUID()}`, `x.${Buffer.from("{oops").toString("base64url")}.y`);
    const otherSub = await account(u.id, "microsoft", `sub-${randomUUID()}`, idToken({ sub: "someone-else", oid: guid() }));
    const badOid = `sub-${randomUUID()}`;
    const notGuid = await account(u.id, "microsoft", badOid, idToken({ sub: badOid, oid: "not-a-guid" }));
    // Two app registrations' pairwise subs for one directory user: same oid.
    const sharedOid = guid();
    const subA = `sub-${randomUUID()}`;
    const subB = `sub-${randomUUID()}`;
    const twinA = await account(u.id, "microsoft", subA, idToken({ sub: subA, oid: sharedOid }));
    const twinB = await account(u.id, "microsoft", subB, idToken({ sub: subB, oid: sharedOid }));
    // A Google row whose token even carries an oid, and a password row.
    const googleSub = `g-${randomUUID()}`;
    await account(u.id, "google", googleSub, idToken({ sub: googleSub, oid: guid() }));
    await account(u.id, "credential", u.id, null);

    const before = await allAccounts();
    const notices = await runMigration();
    const after = await allAccounts();

    const rekeyed = after.find((row) => row.id === migrated.id)!;
    expect(rekeyed.accountId).toBe(oid);
    expect(rekeyed.updatedAt.getTime()).toBeGreaterThan(migrated.updatedAt.getTime());
    expect(rekeyed.idToken).toBe(migrated.idToken);
    expect(after.filter((row) => row.id !== migrated.id)).toEqual(before.filter((row) => row.id !== migrated.id));

    const summary = notices.find((message) => message.includes("re-keyed"));
    expect(summary).toContain("re-keyed 1 of 9 Microsoft sign-in accounts");
    expect(summary).toContain("1 already keyed by oid, 7 left unchanged");
    const unresolved = notices.find((message) => message.includes("gives no oid for that sub"))!;
    for (const row of [noToken, notAJwt, notJson, otherSub, notGuid]) expect(unresolved).toContain(row.id);
    const conflict = notices.find((message) => message.includes("another account row's key"))!;
    expect(conflict).toContain(twinA.id);
    expect(conflict).toContain(twinB.id);
    expect(notices.join("\n")).not.toContain("shared by more than one row");

    const rerunNotices = await runMigration();
    expect(await allAccounts()).toEqual(after);
    expect(rerunNotices.find((message) => message.includes("re-keyed"))).toContain(
      "re-keyed 0 of 9 Microsoft sign-in accounts from sub to oid (2 already keyed by oid, 7 left unchanged)",
    );
  });

  it("never re-keys onto an oid another row already holds, and names rows that share a key", async () => {
    const owner = await user();
    const other = await user();
    const oid = guid();
    const sub = `sub-${randomUUID()}`;
    // A 1.7 sign-in already linked an oid-keyed row for this directory user.
    await account(other.id, "microsoft", oid, idToken({ sub: `sub-${randomUUID()}`, oid }));
    const stale = await account(owner.id, "microsoft", sub, idToken({ sub, oid }));
    // Two Google rows sharing one key: Better Auth 1.7 refuses that sign-in.
    const dupA = await account(owner.id, "google", "g-dup", null);
    const dupB = await account(other.id, "google", "g-dup", null);

    const before = await allAccounts();
    const notices = await runMigration();

    expect(await allAccounts()).toEqual(before);
    expect(notices.find((message) => message.includes("another account row's key"))).toContain(stale.id);
    const duplicates = notices.find((message) => message.includes("shared by more than one row"))!;
    expect(duplicates).toContain(dupA.id);
    expect(duplicates).toContain(dupB.id);
  });

  it("is silent on a box with no Microsoft accounts", async () => {
    const u = await user();
    await account(u.id, "google", `g-${randomUUID()}`, null);
    expect(await runMigration()).toEqual([]);
  });

  it("a Microsoft sign-in after the backfill finds the existing user, not a new one", async () => {
    const email = "entra-person@example.com";
    const existing = await user(email);
    const sub = `pairwise-${randomUUID()}`;
    const oid = guid();
    await account(existing.id, "microsoft", sub, idToken({ iss: ISS, tid: TID, sub, oid, email }));

    const auth = createBetterAuthInstance(
      db,
      {
        authBaseUrlMode: "explicit",
        authPublicBaseUrl: "http://127.0.0.1:3100",
        authDisableSignUp: false,
      } as Parameters<typeof createBetterAuthInstance>[1],
      ["http://127.0.0.1:3100"],
    );
    const app = express();
    app.use(express.json());
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    const signIn = () =>
      request(app)
        .post("/api/auth/sign-in/social")
        .set("Origin", "http://127.0.0.1:3100")
        // A fresh token for the same person: new sub claim set, same oid.
        .send({ provider: "microsoft", idToken: { token: idToken({ iss: ISS, tid: TID, sub, oid, email }) } });
    const context = await auth.$context;
    const ownerOf = () => context.internalAdapter.findAccountOwnerByKey({ providerId: "microsoft", accountId: oid });

    // Before the backfill the 1.7 lookup by oid finds nothing, and the
    // sign-in is refused (the local email is unverified, so no implicit link).
    expect(await ownerOf()).toBeNull();
    const refused = await signIn();
    expect(refused.status, JSON.stringify(refused.body)).not.toBe(200);
    expect(await db.select().from(authAccounts)).toHaveLength(1);

    await runMigration();

    const owner = await ownerOf();
    expect(owner).toMatchObject({ kind: "owned", user: { id: existing.id } });
    const res = await signIn();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.user?.id).toBe(existing.id);
    expect(await db.select().from(authUsers).where(eq(authUsers.email, email))).toHaveLength(1);
    const accounts = await db.select().from(authAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ userId: existing.id, providerId: "microsoft", accountId: oid });
  });
});
