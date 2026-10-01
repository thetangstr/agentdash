import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentStewardships,
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  projectAccess,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  agentVisibilityCondition,
  assertAgentIdVisible,
  issueVisibilityCondition,
  resolveAgentVisibility,
  visibleAgentIdsFor,
} from "../routes/visibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * Agent visibility (2026-09-30), the rule test: one company in 'owner' mode,
 * walked by every kind of actor against a REAL database. The routes that will
 * compose these conditions are covered in the route sweep; what is pinned here
 * is the rule itself, so a route can only get it wrong by not calling it.
 *
 * The property: to a member, an agent they do not answer for is NONEXISTENT —
 * absent from the set, 404 by id — and so is the work attributed to it, unless
 * they are listed on its project. Admins and agents see everything. With the
 * company default left at 'company' and no override, nothing is filtered at
 * all: byte-for-byte today's behaviour.
 */
describeEmbeddedPostgres("agent visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OTHER_COMPANY = randomUUID();

  // Humans
  const ADMIN = "admin-user";
  const TITUS = "titus"; // stewards CASPER, created MADE
  const SAM = "sam"; // member with nothing of their own
  const RITA = "rita"; // accountable for an autonomous agent

  // Agents
  const CASPER = randomUUID(); // stewarded by TITUS
  const DELIVERY = randomUUID(); // reports to CASPER
  const DEEP = randomUUID(); // reports to DELIVERY (transitive)
  const MADE = randomUUID(); // created by TITUS, unpaired
  const SHARED = randomUUID(); // visibility 'company' by override
  const AUTO = randomUUID(); // autonomous, accountable RITA
  const OTHER = randomUUID(); // nobody Titus knows
  const UNDER_SHARED = randomUUID(); // reports to SHARED — must NOT leak through it
  const FOREIGN = randomUUID(); // another company

  // Projects and issues
  const OPEN_PROJECT = randomUUID();
  const LISTED_PROJECT = randomUUID(); // restricted, TITUS on the list
  const SECRET_PROJECT = randomUUID(); // restricted, TITUS off the list
  const ISSUE_CASPER = randomUUID(); // assigned to CASPER
  const ISSUE_BY_DEEP = randomUUID(); // created by DEEP, unassigned
  const ISSUE_OTHER = randomUUID(); // assigned to OTHER
  const ISSUE_MINE = randomUUID(); // assigned to TITUS the human
  const ISSUE_UNASSIGNED = randomUUID(); // nobody's, no project
  const ISSUE_LISTED = randomUUID(); // OTHER's work inside LISTED_PROJECT
  const ISSUE_SECRET = randomUUID(); // CASPER's work inside SECRET_PROJECT

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-visibility-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values([
      { id: COMPANY, name: "Owner-mode Co", agentVisibilityDefault: "owner" },
      { id: OTHER_COMPANY, name: "Elsewhere Co", issuePrefix: "ELS" },
    ]);
    for (const [userId, role] of [
      [ADMIN, "admin"],
      [TITUS, "member"],
      [SAM, "member"],
      [RITA, "member"],
    ] as const) {
      await db.insert(companyMemberships).values({
        companyId: COMPANY,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: role,
      });
    }
    await db.insert(agents).values([
      { id: CASPER, companyId: COMPANY, name: "Casper", role: "chief_of_staff", createdByUserId: ADMIN },
      { id: DELIVERY, companyId: COMPANY, name: "Delivery", role: "pm", reportsTo: CASPER, createdByUserId: ADMIN },
      { id: DEEP, companyId: COMPANY, name: "Deep", role: "general", reportsTo: DELIVERY, createdByUserId: ADMIN },
      { id: MADE, companyId: COMPANY, name: "Made", role: "general", createdByUserId: TITUS },
      { id: SHARED, companyId: COMPANY, name: "Shared", role: "general", createdByUserId: ADMIN, visibility: "company" },
      {
        id: AUTO,
        companyId: COMPANY,
        name: "Auto",
        role: "general",
        createdByUserId: ADMIN,
        autonomy: "autonomous",
        accountableUserId: RITA,
      },
      { id: OTHER, companyId: COMPANY, name: "Other", role: "general", createdByUserId: ADMIN },
      { id: UNDER_SHARED, companyId: COMPANY, name: "Under shared", role: "general", reportsTo: SHARED, createdByUserId: ADMIN },
      { id: FOREIGN, companyId: OTHER_COMPANY, name: "Foreign", role: "general", createdByUserId: TITUS },
    ]);
    await db.insert(agentStewardships).values({ companyId: COMPANY, agentId: CASPER, userId: TITUS });
    await db.insert(projects).values([
      { id: OPEN_PROJECT, companyId: COMPANY, name: "Open", createdByUserId: ADMIN },
      { id: LISTED_PROJECT, companyId: COMPANY, name: "Listed", createdByUserId: ADMIN, visibility: "restricted" },
      { id: SECRET_PROJECT, companyId: COMPANY, name: "Secret", createdByUserId: ADMIN, visibility: "restricted" },
    ]);
    await db.insert(projectAccess).values({
      projectId: LISTED_PROJECT,
      principalType: "user",
      principalId: TITUS,
      grantedByUserId: ADMIN,
    });
    await db.insert(issues).values([
      { id: ISSUE_CASPER, companyId: COMPANY, title: "Casper's task", status: "todo", assigneeAgentId: CASPER, projectId: OPEN_PROJECT },
      { id: ISSUE_BY_DEEP, companyId: COMPANY, title: "Deep filed this", status: "todo", createdByAgentId: DEEP },
      { id: ISSUE_OTHER, companyId: COMPANY, title: "Other's task", status: "todo", assigneeAgentId: OTHER, projectId: OPEN_PROJECT },
      { id: ISSUE_MINE, companyId: COMPANY, title: "Titus's own", status: "todo", assigneeUserId: TITUS },
      { id: ISSUE_UNASSIGNED, companyId: COMPANY, title: "Nobody's", status: "backlog", createdByUserId: ADMIN },
      { id: ISSUE_LISTED, companyId: COMPANY, title: "Other's work, listed project", status: "todo", assigneeAgentId: OTHER, projectId: LISTED_PROJECT },
      { id: ISSUE_SECRET, companyId: COMPANY, title: "Casper's work, secret project", status: "todo", assigneeAgentId: CASPER, projectId: SECRET_PROJECT },
    ]);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Actor = Record<string, unknown>;
  const asUser = (userId: string, role: string, extra: Actor = {}): Actor => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [COMPANY],
    memberships: [{ companyId: COMPANY, membershipRole: role, status: "active" }],
    ...extra,
  });
  const asAgent = (agentId: string): Actor => ({
    type: "agent",
    agentId,
    companyId: COMPANY,
    source: "agent_key",
    companyIds: [COMPANY],
  });
  // A bare request object: the rule reads `req.actor` and caches on the request.
  const reqFor = (actor: Actor) => ({ actor }) as unknown as import("express").Request;

  async function visibleAgentNames(actor: Actor): Promise<string[]> {
    const req = reqFor(actor);
    await resolveAgentVisibility(db, req, COMPANY);
    const rows = await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, COMPANY), agentVisibilityCondition(req, COMPANY, agents.id)));
    return rows.map((row) => row.name).sort();
  }

  async function visibleIssueTitles(actor: Actor): Promise<string[]> {
    const req = reqFor(actor);
    await resolveAgentVisibility(db, req, COMPANY);
    const rows = await db
      .select({ title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, COMPANY), issueVisibilityCondition(req, COMPANY)));
    return rows.map((row) => row.title).sort();
  }

  const ALL_AGENTS = ["Auto", "Casper", "Deep", "Delivery", "Made", "Other", "Shared", "Under shared"];

  describe("the set, in owner mode", () => {
    it("a steward sees the agent they answer for, its whole reporting line, what they created, and shared agents", async () => {
      expect(await visibleAgentNames(asUser(TITUS, "member"))).toEqual(["Casper", "Deep", "Delivery", "Made", "Shared"]);
    });

    it("an accountable human sees their autonomous agent", async () => {
      expect(await visibleAgentNames(asUser(RITA, "member"))).toEqual(["Auto", "Shared"]);
    });

    it("a member with nothing of their own sees only shared agents", async () => {
      expect(await visibleAgentNames(asUser(SAM, "member"))).toEqual(["Shared"]);
    });

    it("an agent reporting to a shared agent does not become visible through it", async () => {
      expect(await visibleAgentNames(asUser(SAM, "member"))).not.toContain("Under shared");
      expect(await visibleAgentNames(asUser(TITUS, "member"))).not.toContain("Under shared");
    });

    it("a company admin, an instance admin and the local board see everything", async () => {
      expect(await visibleAgentNames(asUser(ADMIN, "admin"))).toEqual(ALL_AGENTS);
      expect(await visibleAgentNames(asUser(SAM, "member", { isInstanceAdmin: true }))).toEqual(ALL_AGENTS);
      expect(
        await visibleAgentNames({ type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true }),
      ).toEqual(ALL_AGENTS);
    });

    it("an agent actor is not subject to the rule", async () => {
      expect(await visibleAgentNames(asAgent(OTHER))).toEqual(ALL_AGENTS);
    });

    it("a legacy 'operator' role is a member, not an admin", async () => {
      expect(await visibleAgentNames(asUser(SAM, "operator"))).toEqual(["Shared"]);
    });

    it("visibleAgentIdsFor answers null for those who see everything and the set otherwise", async () => {
      expect(await visibleAgentIdsFor(db, reqFor(asUser(ADMIN, "admin")), COMPANY)).toBeNull();
      const set = await visibleAgentIdsFor(db, reqFor(asUser(TITUS, "member")), COMPANY);
      expect(set && [...set].sort()).toEqual([CASPER, DEEP, DELIVERY, MADE, SHARED].sort());
    });

    it("is resolved once per request and reused", async () => {
      const req = reqFor(asUser(TITUS, "member"));
      const first = await resolveAgentVisibility(db, req, COMPANY);
      const second = await resolveAgentVisibility(db, req, COMPANY);
      expect(second).toBe(first);
    });

    it("refuses to build a condition before the set is resolved — a wiring mistake, not a silent pass", () => {
      const req = reqFor(asUser(TITUS, "member"));
      expect(() => agentVisibilityCondition(req, COMPANY, agents.id)).toThrow(/resolveAgentVisibility/);
      expect(() => issueVisibilityCondition(req, COMPANY)).toThrow(/resolveAgentVisibility/);
    });
  });

  describe("by id", () => {
    it("404 for an agent the member cannot see; passes for one they can", async () => {
      const req = reqFor(asUser(TITUS, "member"));
      await expect(assertAgentIdVisible(db, req, OTHER)).rejects.toMatchObject({ status: 404 });
      await expect(assertAgentIdVisible(db, req, UNDER_SHARED)).rejects.toMatchObject({ status: 404 });
      await expect(assertAgentIdVisible(db, req, CASPER)).resolves.toBeUndefined();
      await expect(assertAgentIdVisible(db, req, DEEP)).resolves.toBeUndefined();
      await expect(assertAgentIdVisible(db, req, SHARED)).resolves.toBeUndefined();
    });

    it("404 for a non-canonical id, however Postgres would cast it (fail closed)", async () => {
      const req = reqFor(asUser(ADMIN, "admin"));
      await expect(assertAgentIdVisible(db, req, OTHER.replace(/-/g, ""))).rejects.toMatchObject({ status: 404 });
      await expect(assertAgentIdVisible(db, req, `{${OTHER}}`)).rejects.toMatchObject({ status: 404 });
      await expect(assertAgentIdVisible(db, req, "casper")).rejects.toMatchObject({ status: 404 });
    });

    it("an unknown but well-formed id passes through to the route's own 404", async () => {
      await expect(assertAgentIdVisible(db, reqFor(asUser(TITUS, "member")), randomUUID())).resolves.toBeUndefined();
    });

    it("the error never names the agent", async () => {
      await assertAgentIdVisible(db, reqFor(asUser(SAM, "member")), OTHER).catch((err: Error) => {
        expect(err.message).not.toMatch(/Other/);
      });
    });
  });

  describe("issues, in owner mode", () => {
    it("a steward sees their agents' work, their own work, and the listed project — nothing else", async () => {
      expect(await visibleIssueTitles(asUser(TITUS, "member"))).toEqual(
        ["Casper's task", "Deep filed this", "Other's work, listed project", "Titus's own"].sort(),
      );
    });

    it("the project rule is never relaxed: a visible agent's work in a secret project stays hidden", async () => {
      expect(await visibleIssueTitles(asUser(TITUS, "member"))).not.toContain("Casper's work, secret project");
    });

    it("a member with nothing sees nothing — not even unassigned company work", async () => {
      expect(await visibleIssueTitles(asUser(SAM, "member"))).toEqual([]);
    });

    it("an admin sees everything but still obeys nothing — admins are exempt from both rules", async () => {
      expect(await visibleIssueTitles(asUser(ADMIN, "admin"))).toHaveLength(7);
    });

    it("an agent actor keeps A5 only", async () => {
      // OTHER is off both restricted projects' lists: it loses those two issues and nothing else.
      expect(await visibleIssueTitles(asAgent(OTHER))).toEqual(
        ["Casper's task", "Deep filed this", "Nobody's", "Other's task", "Titus's own"].sort(),
      );
    });
  });

  describe("company mode", () => {
    beforeAll(async () => {
      await db.update(companies).set({ agentVisibilityDefault: "company" }).where(eq(companies.id, COMPANY));
    });
    afterAll(async () => {
      await db.update(companies).set({ agentVisibilityDefault: "owner" }).where(eq(companies.id, COMPANY));
      await db.update(agents).set({ visibility: null }).where(eq(agents.id, OTHER));
    });

    it("with no override anywhere, nothing is filtered: today's behaviour, for everyone", async () => {
      expect(await visibleAgentNames(asUser(SAM, "member"))).toEqual(ALL_AGENTS);
      expect(await visibleIssueTitles(asUser(SAM, "member"))).toEqual(
        ["Casper's task", "Deep filed this", "Nobody's", "Other's task", "Titus's own"].sort(),
      );
      // The cheap path: the scope says 'all' and no set was built.
      const scope = await resolveAgentVisibility(db, reqFor(asUser(SAM, "member")), COMPANY);
      expect(scope.mode).toBe("all");
    });

    it("one agent marked 'owner' vanishes for members, with the issues attributed to it, and nothing else changes", async () => {
      await db.update(agents).set({ visibility: "owner" }).where(eq(agents.id, OTHER));
      expect(await visibleAgentNames(asUser(SAM, "member"))).toEqual(ALL_AGENTS.filter((name) => name !== "Other"));
      expect(await visibleIssueTitles(asUser(SAM, "member"))).toEqual(
        ["Casper's task", "Deep filed this", "Nobody's", "Titus's own"].sort(),
      );
      expect(await visibleAgentNames(asUser(ADMIN, "admin"))).toEqual(ALL_AGENTS);
      await expect(assertAgentIdVisible(db, reqFor(asUser(SAM, "member")), OTHER)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("across companies", () => {
    it("the scope is per company: an agent the member created elsewhere is not in this company's set", async () => {
      const set = await visibleAgentIdsFor(db, reqFor(asUser(TITUS, "member")), COMPANY);
      expect(set?.has(FOREIGN)).toBe(false);
    });
  });
});
