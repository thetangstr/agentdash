// Integration coverage for inviteService against an embedded Postgres.
// Asserts the surface contract the onboarding wizard depends on:
//   - row is inserted, returned id is real
//   - the plaintext token starts with the documented prefix
//   - the persisted token is hashed (never stored verbatim)
//   - the email is stored in defaults_payload for audit
//   - expiresAt is in the future (~72h window)
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { companies, createDb, invites } from "@paperclipai/db";
import { inviteService } from "../services/invites.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("inviteService.createCompanyInvite", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invites-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(invites);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Invite Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("inserts a company-join invite and returns a usable plaintext token", async () => {
    const companyId = await seedCompany();
    const result = await inviteService(db).createCompanyInvite({
      companyId,
      invitedByUserId: "u1",
      email: "Carol@Example.COM",
    });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.token).toMatch(/^pcp_invite_[a-z0-9]{8}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000);

    const [row] = await db.select().from(invites).where(eq(invites.id, result.id));
    expect(row).toBeDefined();
    expect(row?.companyId).toBe(companyId);
    expect(row?.invitedByUserId).toBe("u1");
    expect(row?.inviteType).toBe("company_join");
    expect(row?.allowedJoinTypes).toBe("both");
    // Token is stored hashed; the plaintext is only returned to the caller.
    const expectedHash = createHash("sha256").update(result.token).digest("hex");
    expect(row?.tokenHash).toBe(expectedHash);
    // Email is normalized lowercase + trimmed.
    expect(row?.defaultsPayload).toEqual({ email: "carol@example.com" });
  });

  it("omits the email payload when no email is supplied", async () => {
    const companyId = await seedCompany();
    const result = await inviteService(db).createCompanyInvite({
      companyId,
      invitedByUserId: null,
    });
    const [row] = await db.select().from(invites).where(eq(invites.id, result.id));
    expect(row?.defaultsPayload).toBeNull();
    expect(row?.invitedByUserId).toBeNull();
  });

  it("respects an allowedJoinTypes override", async () => {
    const companyId = await seedCompany();
    const result = await inviteService(db).createCompanyInvite({
      companyId,
      invitedByUserId: "u1",
      allowedJoinTypes: "agent",
    });
    const [row] = await db.select().from(invites).where(eq(invites.id, result.id));
    expect(row?.allowedJoinTypes).toBe("agent");
  });
});
