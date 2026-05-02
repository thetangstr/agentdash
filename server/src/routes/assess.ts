import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assessService } from "../services/assess.js";
// AgentDash: project-mode imports
import { assessProjectService } from "../services/assess-project.js";
import { buildProjectDocx } from "../services/assess-project-docx.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function httpStatus(err: unknown): number {
  const e = err as { statusCode?: number; status?: number };
  return e.statusCode ?? e.status ?? 500;
}

export function assessRoutes(db: Db) {
  const router = Router();
  const svc = assessService(db);
  // AgentDash: project-mode service
  const projectSvc = assessProjectService(db);

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
  router.post("/companies/:companyId/assess", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

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

  return router;
}
