import { Router } from "express";
import type { Db } from "@agentdash/db";
import { assessService } from "../services/assess.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function httpStatus(err: unknown): number {
  const e = err as { statusCode?: number; status?: number };
  return e.statusCode ?? e.status ?? 500;
}

export function assessRoutes(db: Db) {
  const router = Router();
  const svc = assessService(db);

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

  // POST /companies/:companyId/assess/interview — WACT interview round
  router.post("/companies/:companyId/assess/interview", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.interview(req.body);
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

  return router;
}
