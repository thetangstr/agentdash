// AgentDash: POST a bug report or feature request straight into the team's
// GitHub queue. Open to any signed-in board user — the point is that the
// person who hit the problem can file it, not just whoever owns the repo.
//
// It is also open to AGENTS. That is not a convenience: for anyone driving
// AgentDash from their own terminal, their agent is the interface, and "tell
// your agent to file a bug" only works if the agent's own credential is
// allowed to file. A board-only route would have made the MCP tool a button
// that always returns 401 — which is how the same gap showed up during
// external testing, as "permissions felt incomplete".

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { serviceUnavailable, unauthorized } from "../errors.js";
import { serverVersion } from "../version.js";
import { assertCompanyAccess } from "./authz.js";
import {
  ISSUE_REPORT_KINDS,
  MAX_REPORT_DESCRIPTION_LENGTH,
  MAX_REPORT_TITLE_LENGTH,
  createIssueReport,
  resolveGitHubIssuesConfig,
  type IssueReportKind,
} from "../services/github-issues.js";

const kinds = [...ISSUE_REPORT_KINDS] as [IssueReportKind, ...IssueReportKind[]];

const issueReportSchema = z.object({
  kind: z.enum(kinds),
  title: z.string().trim().min(3, "Give the report a title").max(MAX_REPORT_TITLE_LENGTH),
  description: z
    .string()
    .trim()
    .min(10, "Describe what happened")
    .max(MAX_REPORT_DESCRIPTION_LENGTH),
  companyId: z.string().uuid().optional(),
  // Where the reporter was standing when they hit it. Client-supplied and
  // therefore untrusted — it is redacted and length-capped like any other
  // free text before it reaches GitHub.
  pageUrl: z.string().trim().max(500).optional(),
});

export function issueReportRoutes(db: Db) {
  const router = Router();

  // Lets the UI hide the button on instances with no GitHub credential,
  // rather than offering an action that can only fail. Deliberately exposes
  // the repo slug and nothing else — never the token.
  router.get("/config", (req, res) => {
    if (req.actor.type !== "board" && req.actor.type !== "agent") {
      throw unauthorized("Sign-in required");
    }
    const config = resolveGitHubIssuesConfig();
    res.json({
      enabled: Boolean(config),
      repo: config ? `${config.owner}/${config.repo}` : null,
    });
  });

  router.post("/", validate(issueReportSchema), async (req, res) => {
    const actor = req.actor;
    const isBoard = actor.type === "board" && Boolean(actor.userId);
    const isAgent = actor.type === "agent" && Boolean(actor.agentId);
    if (!isBoard && !isAgent) {
      throw unauthorized("Sign-in required to file a report");
    }

    const config = resolveGitHubIssuesConfig();
    if (!config) {
      throw serviceUnavailable("Issue reporting is not configured on this instance.");
    }

    const { kind, title, description, companyId, pageUrl } = req.body as z.infer<
      typeof issueReportSchema
    >;

    // An agent's company comes from its own credential, never from the body.
    // A board user may name a company, but only one it can prove access to.
    // Either way the provenance line is resolved server-side, so a caller
    // cannot file a report stamped with a company it has nothing to do with.
    const effectiveCompanyId = actor.type === "agent" ? actor.companyId : companyId;

    let companyName: string | null = null;
    if (effectiveCompanyId) {
      if (actor.type === "board") assertCompanyAccess(req, effectiveCompanyId);
      const [row] = await db
        .select({ name: companies.name })
        .from(companies)
        .where(eq(companies.id, effectiveCompanyId))
        .limit(1);
      companyName = row?.name ?? null;
    }

    // "Who hit this" is the first question anyone asks about a bug report, and
    // for an agent-filed one the honest answer names the agent — a maintainer
    // who reads "Reported by: Chief of Staff (agent)" knows to expect a
    // machine-written repro and knows which steward to go back to.
    let reporterName: string | null = null;
    let reporterEmail: string | null = null;
    if (actor.type === "agent" && actor.agentId) {
      const [row] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, actor.agentId))
        .limit(1);
      reporterName = `${row?.name ?? "Unknown agent"} (agent)`;
    } else if (actor.type === "board") {
      reporterName = actor.userName ?? null;
      reporterEmail = actor.userEmail ?? null;
    }

    const created = await createIssueReport({
      config,
      kind,
      title,
      description,
      context: {
        reporterName,
        reporterEmail,
        companyName,
        instanceName: process.env.PAPERCLIP_INSTANCE_ID?.trim() || null,
        pageUrl: pageUrl ?? null,
        appVersion: serverVersion,
      },
    });

    res.status(201).json(created);
  });

  return router;
}
