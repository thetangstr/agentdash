import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assistantAccessTokens,
  assistantAuthRequests,
  assistantGrants,
  assistantRefreshTokens,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { assistantOAuthService } from "../services/assistant-oauth.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REDIRECT_URI = "https://assistant.example/callback";
const RESOURCE = "https://box.example/api/assistant/mcp";

/**
 * AgentDash (GH #677, release blocker): migration 0129 gave assistant_grants and
 * assistant_auth_requests NO ACTION foreign keys to companies, and the tokens
 * NO ACTION keys to grants. companyService.remove never deleted any of them, so
 * DELETE /companies/:id failed for every company an assistant had connected to.
 * This drives a real connection through the OAuth service (register, authorize,
 * consent, code exchange), then deletes the company.
 */
describeEmbeddedPostgres("company delete clears assistant OAuth grants and tokens", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-delete-assistant-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function connectAssistant(companyId: string, userId: string) {
    const oauth = assistantOAuthService(db);
    const client = await oauth.registerClient({ client_name: "Test assistant", redirect_uris: [REDIRECT_URI] });
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const request = await oauth.beginAuthorize({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      responseType: "code",
      state: "s",
      scope: undefined,
      resource: RESOURCE,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      canonicalResource: RESOURCE,
    });
    const { redirect, grant } = await oauth.approveConsent({
      requestId: request.id,
      userId,
      companyId,
      scopes: [request.scope.split(" ")[0]!],
      issuerBase: "https://box.example",
    });
    const code = new URL(redirect).searchParams.get("code");
    expect(code).toBeTruthy();
    await oauth.exchangeCode({
      code: code!,
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      resource: RESOURCE,
    });
    return grant;
  }

  it("removes a company after an assistant connected to it", async () => {
    const userId = `user-${randomUUID()}`;
    const company = await db
      .insert(companies)
      .values({ name: `Del ${randomUUID()}`, issuePrefix: `AG${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    // A second company whose grant must survive the delete.
    const other = await db
      .insert(companies)
      .values({ name: `Keep ${randomUUID()}`, issuePrefix: `KP${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    for (const c of [company, other]) {
      await db.insert(companyMemberships).values({
        companyId: c.id,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "owner",
      });
    }

    const grant = await connectAssistant(company.id, userId);
    const otherGrant = await connectAssistant(other.id, userId);

    // The connection really wrote every FK-holding row.
    expect(await db.select().from(assistantAccessTokens).where(eq(assistantAccessTokens.grantId, grant.id))).toHaveLength(1);
    expect(await db.select().from(assistantRefreshTokens).where(eq(assistantRefreshTokens.grantId, grant.id))).toHaveLength(1);
    expect(await db.select().from(assistantAuthRequests).where(eq(assistantAuthRequests.companyId, company.id))).toHaveLength(1);

    const removed = await companyService(db).remove(company.id);
    expect(removed?.id).toBe(company.id);

    expect(await db.select().from(companies).where(eq(companies.id, company.id))).toHaveLength(0);
    expect(await db.select().from(assistantGrants).where(eq(assistantGrants.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(assistantAuthRequests).where(eq(assistantAuthRequests.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(assistantAccessTokens).where(eq(assistantAccessTokens.grantId, grant.id))).toHaveLength(0);
    expect(await db.select().from(assistantRefreshTokens).where(eq(assistantRefreshTokens.grantId, grant.id))).toHaveLength(0);

    // The other company's connection is untouched.
    expect(await db.select().from(assistantGrants).where(eq(assistantGrants.id, otherGrant.id))).toHaveLength(1);
    expect(await db.select().from(assistantAccessTokens).where(eq(assistantAccessTokens.grantId, otherGrant.id))).toHaveLength(1);
    expect(await db.select().from(assistantRefreshTokens).where(eq(assistantRefreshTokens.grantId, otherGrant.id))).toHaveLength(1);
    expect(await db.select().from(assistantAuthRequests).where(eq(assistantAuthRequests.companyId, other.id))).toHaveLength(1);
  });
});
