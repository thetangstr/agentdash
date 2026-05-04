import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assessService } from "../services/assess.js";
// AgentDash: project-mode imports
import { assessProjectService } from "../services/assess-project.js";
import { buildProjectDocx } from "../services/assess-project-docx.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
// AgentDash (Phase D): deep-interview engine wiring (flag-gated, default OFF)
import { deepInterviewEngine, type EngineLLMDispatch } from "../services/deep-interview-engine.js";
import { dispatchLLM } from "../services/dispatch-llm.js";
import type { AgentAdapterType } from "@paperclipai/shared";
import type { DeepInterviewScope } from "@paperclipai/shared/deep-interview";

function httpStatus(err: unknown): number {
  const e = err as { statusCode?: number; status?: number };
  return e.statusCode ?? e.status ?? 500;
}

/**
 * AgentDash (Phase D): read the deep-interview flag at request-handling time
 * (NOT module load) so a flag flip takes effect without a restart.
 */
function deepInterviewEnabled(): boolean {
  return process.env.AGENTDASH_DEEP_INTERVIEW_ASSESS === "true";
}

function defaultAdapter(): AgentAdapterType {
  return ((process.env.AGENTDASH_DEFAULT_ADAPTER ?? "claude_api").trim() ||
    "claude_api") as AgentAdapterType;
}

export function assessRoutes(db: Db) {
  const router = Router();
  const svc = assessService(db);
  // AgentDash: project-mode service
  const projectSvc = assessProjectService(db);
  // AgentDash (Phase D): production wiring uses the dispatchLLM service. Tests
  // can override by mocking the module at import time.
  const engine = deepInterviewEngine({
    db,
    dispatchLLM: dispatchLLM as EngineLLMDispatch,
  });

  // POST /companies/:companyId/assess/research — lightweight URL research
  router.post("/companies/:companyId/assess/research", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { companyUrl, companyName } = req.body;
      const result = await svc.research(companyUrl ?? "", companyName ?? "");
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(httpStatus(err)).json({ error: message });
    }
  });

  // POST /companies/:companyId/assess — run full assessment (streaming)
  // AgentDash (Phase D): when AGENTDASH_DEEP_INTERVIEW_ASSESS=true, drive a
  // deep-interview turn instead of the legacy MiniMax streaming markdown call.
  // The engine emits a single question per turn; we stream that as plain text
  // so the existing UI (which appends streamed chunks) renders the question.
  router.post("/companies/:companyId/assess", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      if (deepInterviewEnabled()) {
        const initialIdea = typeof req.body?.description === "string"
          ? req.body.description
          : typeof req.body?.oneLineGoal === "string"
            ? req.body.oneLineGoal
            : "";
        const userAnswer = typeof req.body?.userAnswer === "string"
          ? req.body.userAnswer
          : undefined;

        const turn = await engine.nextTurn({
          scope: "cos_onboarding" as DeepInterviewScope,
          scopeRefId: companyId,
          userId: req.actor.userId ?? "board",
          companyId,
          initialIdea,
          adapter: defaultAdapter(),
          userAnswer,
        });

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Content-Type-Options", "nosniff");
        // Stream the engine output as plain text. Existing UI appends chunks.
        if (turn.kind === "question") {
          res.write(turn.question);
        } else {
          res.write(
            `[deep-interview] Ready to crystallize at round ${turn.round} (ambiguity ${turn.ambiguityScore.toFixed(3)}).`,
          );
        }
        res.end();
        return;
      }

      const { stream, onComplete } = await svc.runAssessment(companyId, req.body, req.body.companyWebContent);

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");

      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let fullOutput = "";

      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Parse SSE lines for content_block_delta text
          for (const line of chunk.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              if (json.type === "content_block_delta" && json.delta?.text) {
                fullOutput += json.delta.text;
                res.write(json.delta.text);
              }
            } catch { /* skip non-JSON lines */ }
          }
        }
      };

      await pump();
      res.end();

      // Fire-and-forget: store results + generate jumpstart
      onComplete(fullOutput).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "unknown";
        console.error("assess onComplete error:", msg);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      if (!res.headersSent) res.status(httpStatus(err)).json({ error: message });
    }
  });

  // GET /companies/:companyId/assess — get stored assessment
  router.get("/companies/:companyId/assess", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.getAssessment(companyId);
      if (!result) { res.status(404).json({ error: "No assessment found" }); return; }
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(httpStatus(err)).json({ error: message });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // AgentDash: Project-mode endpoints
  // ────────────────────────────────────────────────────────────────────

  // POST /companies/:companyId/assess/project/clarify — single-shot JSON of 3-5 clarifying questions
  router.post("/companies/:companyId/assess/project/clarify", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const intake = req.body?.intake;
      if (!intake || typeof intake !== "object") {
        res.status(400).json({ error: "Missing intake object" });
        return;
      }

      if (deepInterviewEnabled()) {
        // AgentDash (Phase D): engine path — one engine turn produces one
        // question, which we surface as the SOLE clarify question in the UI's
        // existing { rephrased, questions } envelope. Subsequent turns flow
        // through /followup so we don't need to re-emit the rephrase.
        const projectId = typeof (intake as { projectId?: string }).projectId === "string"
          ? (intake as { projectId: string }).projectId
          : `${companyId}:${((intake as { projectName?: string }).projectName ?? "project").slice(0, 64)}`;
        const initialIdea = [
          (intake as { projectName?: string }).projectName ?? "",
          (intake as { oneLineGoal?: string }).oneLineGoal ?? "",
          (intake as { description?: string }).description ?? "",
        ].filter(Boolean).join("\n\n");

        const turn = await engine.nextTurn({
          scope: "assess_project" as DeepInterviewScope,
          scopeRefId: projectId,
          userId: req.actor.userId ?? "board",
          companyId,
          initialIdea,
          adapter: defaultAdapter(),
        });

        res.json({
          rephrased: (intake as { oneLineGoal?: string }).oneLineGoal ?? initialIdea.slice(0, 160),
          questions: turn.kind === "question"
            ? [{ id: `r${turn.round}`, question: turn.question, hint: "", options: [] }]
            : [],
        });
        return;
      }

      const result = await projectSvc.generateClarifyQuestions(companyId, intake);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(httpStatus(err)).json({ error: message });
    }
  });

  // POST /companies/:companyId/assess/project/followup — two-phase adaptive follow-up
  router.post("/companies/:companyId/assess/project/followup", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { intake, answers, rephrased } = req.body ?? {};
      if (!intake || !Array.isArray(answers)) {
        res.status(400).json({ error: "Missing intake or answers" });
        return;
      }

      if (deepInterviewEnabled()) {
        const projectId = typeof (intake as { projectId?: string }).projectId === "string"
          ? (intake as { projectId: string }).projectId
          : `${companyId}:${((intake as { projectName?: string }).projectName ?? "project").slice(0, 64)}`;
        const initialIdea = [
          (intake as { projectName?: string }).projectName ?? "",
          (intake as { oneLineGoal?: string }).oneLineGoal ?? "",
          (intake as { description?: string }).description ?? "",
        ].filter(Boolean).join("\n\n");

        // The most recent answer drives the next engine turn.
        const lastAnswer = answers.length > 0
          ? String((answers[answers.length - 1] as { text?: unknown })?.text ?? "")
          : "";

        const turn = await engine.nextTurn({
          scope: "assess_project" as DeepInterviewScope,
          scopeRefId: projectId,
          userId: req.actor.userId ?? "board",
          companyId,
          initialIdea,
          adapter: defaultAdapter(),
          userAnswer: lastAnswer || undefined,
        });

        res.json({
          rephrased: typeof rephrased === "string" ? rephrased : "",
          questions: turn.kind === "question"
            ? [{ id: `r${turn.round}`, question: turn.question, hint: "", options: [] }]
            : [],
        });
        return;
      }

      const result = await projectSvc.generateFollowUp(intake, answers, rephrased ?? "");
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(httpStatus(err)).json({ error: message });
    }
  });

  // POST /companies/:companyId/assess/project/run — streaming markdown report
  router.post("/companies/:companyId/assess/project/run", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { intake, answers, rephrased } = req.body ?? {};
      if (!intake || !Array.isArray(answers)) {
        res.status(400).json({ error: "Missing intake or answers" });
        return;
      }

      if (deepInterviewEnabled()) {
        // AgentDash (Phase D): engine path — drive one final turn, stream out
        // the next question or the crystallization marker. Phase F will
        // replace this with the crystallizeAndAdvanceCos handoff.
        const projectId = typeof (intake as { projectId?: string }).projectId === "string"
          ? (intake as { projectId: string }).projectId
          : `${companyId}:${((intake as { projectName?: string }).projectName ?? "project").slice(0, 64)}`;
        const initialIdea = [
          (intake as { projectName?: string }).projectName ?? "",
          (intake as { oneLineGoal?: string }).oneLineGoal ?? "",
          (intake as { description?: string }).description ?? "",
        ].filter(Boolean).join("\n\n");

        const lastAnswer = answers.length > 0
          ? String((answers[answers.length - 1] as { text?: unknown })?.text ?? "")
          : "";

        const turn = await engine.nextTurn({
          scope: "assess_project" as DeepInterviewScope,
          scopeRefId: projectId,
          userId: req.actor.userId ?? "board",
          companyId,
          initialIdea,
          adapter: defaultAdapter(),
          userAnswer: lastAnswer || undefined,
        });

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (turn.kind === "question") {
          res.write(turn.question);
        } else {
          res.write(
            `[deep-interview] Ready to crystallize at round ${turn.round} (ambiguity ${turn.ambiguityScore.toFixed(3)}).`,
          );
        }
        res.end();
        return;
      }

      const { stream, onComplete } = await projectSvc.runProjectAssessment(companyId, {
        intake,
        answers,
        rephrased: typeof rephrased === "string" ? rephrased : "",
      });

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");

      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let fullOutput = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            if (json.type === "content_block_delta" && json.delta?.text) {
              fullOutput += json.delta.text;
              res.write(json.delta.text);
            }
          } catch { /* skip non-JSON lines */ }
        }
      }
      res.end();

      onComplete(fullOutput).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "unknown";
        console.error("project assess onComplete error:", msg);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      if (!res.headersSent) res.status(httpStatus(err)).json({ error: message });
    }
  });

  // POST /companies/:companyId/assess/project/docx — build .docx on demand
  router.post("/companies/:companyId/assess/project/docx", async (req, res) => {
    try {
      assertCompanyAccess(req, req.params.companyId as string);
      const { markdown, projectName, companyName } = req.body ?? {};
      if (typeof markdown !== "string" || !markdown.trim()) {
        res.status(400).json({ error: "Missing markdown" });
        return;
      }
      if (typeof projectName !== "string" || !projectName.trim()) {
        res.status(400).json({ error: "Missing projectName" });
        return;
      }
      const safeCompany = (typeof companyName === "string" && companyName.trim()) || "AgentDash";
      const safeProject = projectName.trim();

      const buf = await buildProjectDocx({
        markdown,
        projectName: safeProject,
        companyName: safeCompany,
      });

      const safeFilename = `${safeCompany} - ${safeProject}.docx`
        .replace(/[^\x20-\x7E]+/g, "_")
        .replace(/[\\/:*?"<>|]+/g, "_");
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
      res.setHeader("Content-Length", String(buf.length));
      res.end(buf);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      if (!res.headersSent) res.status(httpStatus(err)).json({ error: message });
    }
  });

  // GET /companies/:companyId/assess/project/list — past project assessments
  router.get("/companies/:companyId/assess/project/list", async (req, res) => {
    try {
      assertCompanyAccess(req, req.params.companyId as string);
      const result = await projectSvc.listProjectAssessments(req.params.companyId as string);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(httpStatus(err)).json({ error: message });
    }
  });

  // GET /companies/:companyId/assess/project/:slug — get a single stored project assessment
  router.get("/companies/:companyId/assess/project/:slug", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      const slug = req.params.slug as string;
      assertCompanyAccess(req, companyId);
      const result = await projectSvc.getProjectAssessment(companyId, slug);
      if (!result) { res.status(404).json({ error: "No project assessment found" }); return; }
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(httpStatus(err)).json({ error: message });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // AgentDash (Phase D): GET /onboarding/in-progress
  //
  // Resume support (Pre-mortem #2 mitigation): the SPA calls this on
  // /assess load to determine whether to offer "resume your interview".
  // Returns the in-progress deep_interview_states row for (scope, scopeRefId);
  // null when none. Mounted under /api at the app level so the final URL is
  // GET /api/onboarding/in-progress?scope=...&scopeRefId=...
  // ────────────────────────────────────────────────────────────────────
  router.get("/onboarding/in-progress", async (req, res) => {
    try {
      const scope = String(req.query.scope ?? "");
      const scopeRefId = String(req.query.scopeRefId ?? "");
      if (scope !== "cos_onboarding" && scope !== "assess_project") {
        res.status(400).json({ error: "scope must be 'cos_onboarding' or 'assess_project'" });
        return;
      }
      if (!scopeRefId) {
        res.status(400).json({ error: "scopeRefId required" });
        return;
      }
      // Authorization: the caller must have access to the company associated
      // with this state row. For cos_onboarding scope, scopeRefId is the
      // companyId (per Phase D wiring). For assess_project, scopeRefId is a
      // synthetic project key prefixed with "<companyId>:" — we extract the
      // companyId for the access check.
      let companyIdForAuthz = scopeRefId;
      if (scope === "assess_project") {
        const sep = scopeRefId.indexOf(":");
        if (sep > 0) companyIdForAuthz = scopeRefId.slice(0, sep);
      }
      assertCompanyAccess(req, companyIdForAuthz);

      const state = await engine.getInProgress(scope as DeepInterviewScope, scopeRefId);
      const resumeUrl = state
        ? scope === "cos_onboarding"
          ? `/assess?onboarding=1`
          : `/assess?mode=project`
        : null;
      res.json({ state, resumeUrl });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(httpStatus(err)).json({ error: message });
    }
  });

  return router;
}
