/**
 * AGE-44: Unit tests for the Chief of Staff system-prompt resolver and the
 * backfill migration that re-points existing assistant_conversations at the
 * company's role='chief_of_staff' agent.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  agents,
  assistantConversations,
  companies,
  createDb,
} from "@agentdash/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  formatInstructionsBundleAsSystemPrompt,
  loadDefaultAgentInstructionsBundle,
} from "../services/default-agent-instructions.ts";
import { resolveChiefOfStaffSystemPrompt } from "../services/assistant-llm.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres assistant-cos-prompt tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("formatInstructionsBundleAsSystemPrompt", () => {
  it("concatenates SOUL, AGENTS, HEARTBEAT, TOOLS in canonical order", () => {
    const prompt = formatInstructionsBundleAsSystemPrompt({
      "TOOLS.md": "TOOLS body",
      "SOUL.md": "SOUL body",
      "HEARTBEAT.md": "HEARTBEAT body",
      "AGENTS.md": "AGENTS body",
    });
    const indexOf = (needle: string) => prompt.indexOf(needle);
    expect(indexOf("SOUL body")).toBeGreaterThanOrEqual(0);
    expect(indexOf("SOUL body")).toBeLessThan(indexOf("AGENTS body"));
    expect(indexOf("AGENTS body")).toBeLessThan(indexOf("HEARTBEAT body"));
    expect(indexOf("HEARTBEAT body")).toBeLessThan(indexOf("TOOLS body"));
    expect(prompt).toContain("# SOUL.md");
  });

  it("skips empty/whitespace files", () => {
    const prompt = formatInstructionsBundleAsSystemPrompt({
      "SOUL.md": "SOUL body",
      "AGENTS.md": "   ",
      "HEARTBEAT.md": "HEARTBEAT body",
    });
    expect(prompt).toContain("SOUL body");
    expect(prompt).toContain("HEARTBEAT body");
    expect(prompt).not.toContain("AGENTS body");
  });
});

describe("loadDefaultAgentInstructionsBundle", () => {
  it("returns the CoS bundle when called with (db, agent)", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle({} as never, {
      id: randomUUID(),
      role: "chief_of_staff",
    });
    expect(Object.keys(bundle).sort()).toEqual(
      ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"].sort(),
    );
    expect(bundle["SOUL.md"].length).toBeGreaterThan(0);
  });

  it("falls back to default bundle for unknown role", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle({} as never, {
      id: randomUUID(),
      role: "engineer",
    });
    expect(Object.keys(bundle)).toEqual(["AGENTS.md"]);
  });

  it("still supports the legacy role-only signature", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("chief_of_staff");
    expect(bundle["SOUL.md"].length).toBeGreaterThan(0);
  });
});

describeEmbeddedPostgres("resolveChiefOfStaffSystemPrompt", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assistant-cos-prompt-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(assistantConversations);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns null systemPrompt when the company has no chief_of_staff agent", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "AcmeCo",
      issuePrefix: `AC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const resolution = await resolveChiefOfStaffSystemPrompt(db, companyId);
    expect(resolution.agent).toBeNull();
    expect(resolution.systemPrompt).toBeNull();
  });

  it("returns the CoS agent + SOUL-led system prompt when one exists", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "AcmeCo",
      issuePrefix: `AC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const cosId = randomUUID();
    await db.insert(agents).values({
      id: cosId,
      companyId,
      name: "Chief of Staff",
      role: "chief_of_staff",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const resolution = await resolveChiefOfStaffSystemPrompt(db, companyId);
    expect(resolution.agent?.id).toBe(cosId);
    expect(resolution.agent?.role).toBe("chief_of_staff");
    expect(resolution.systemPrompt).not.toBeNull();

    // Confirm the prompt actually contains the bundled SOUL.md content.
    const soulContent = await readFile(
      fileURLToPath(
        new URL("../onboarding-assets/chief_of_staff/SOUL.md", import.meta.url),
      ),
      "utf8",
    );
    const soulSample = soulContent.trim().slice(0, 40);
    expect(resolution.systemPrompt!).toContain(soulSample);
  });

  it("ignores chief_of_staff agents from other companies", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    for (const id of [companyA, companyB]) {
      await db.insert(companies).values({
        id,
        name: `Company-${id.slice(0, 4)}`,
        issuePrefix: `CP${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }

    await db.insert(agents).values({
      id: randomUUID(),
      companyId: companyB,
      name: "B Chief of Staff",
      role: "chief_of_staff",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const resolution = await resolveChiefOfStaffSystemPrompt(db, companyA);
    expect(resolution.agent).toBeNull();
  });
});

describeEmbeddedPostgres("AGE-44 backfill migration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let migrationSql!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assistant-backfill-");
    db = createDb(tempDb.connectionString);
    migrationSql = await readFile(
      fileURLToPath(
        new URL(
          "../../../packages/db/src/migrations/0077_backfill_assistant_conversations_cos.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
  }, 30_000);

  afterEach(async () => {
    await db.delete(assistantConversations);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("repoints existing conversations at the company's chief_of_staff agent", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "AcmeCo",
      issuePrefix: `AC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    // Legacy role='assistant' agent that pre-existing conversations currently point at.
    const legacyAssistantId = randomUUID();
    await db.insert(agents).values({
      id: legacyAssistantId,
      companyId,
      name: "Legacy Assistant",
      role: "assistant",
      status: "active",
      adapterType: "assistant",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const cosId = randomUUID();
    await db.insert(agents).values({
      id: cosId,
      companyId,
      name: "Chief of Staff",
      role: "chief_of_staff",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const convoId = randomUUID();
    await db.insert(assistantConversations).values({
      id: convoId,
      companyId,
      userId: "user-1",
      assistantAgentId: legacyAssistantId,
      status: "active",
    });

    for (const statement of migrationSql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
      await db.execute(sql.raw(statement));
    }

    const [row] = await db
      .select({ assistantAgentId: assistantConversations.assistantAgentId })
      .from(assistantConversations);
    expect(row.assistantAgentId).toBe(cosId);

    // Legacy row must still exist -- migration is non-destructive.
    const legacyRows = await db.select().from(agents);
    expect(legacyRows.some((r) => r.id === legacyAssistantId)).toBe(true);
  });

  it("leaves conversations alone for companies with no chief_of_staff agent", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "AcmeCo",
      issuePrefix: `AC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const convoId = randomUUID();
    await db.insert(assistantConversations).values({
      id: convoId,
      companyId,
      userId: "user-1",
      assistantAgentId: null,
      status: "active",
    });

    for (const statement of migrationSql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
      await db.execute(sql.raw(statement));
    }

    const [row] = await db
      .select({ assistantAgentId: assistantConversations.assistantAgentId })
      .from(assistantConversations);
    expect(row.assistantAgentId).toBeNull();
  });
});
