// AgentDash: /solve survey — submission API (AGE-104).
//
// POST /api/solve-submit
//   body: SolveSubmission JSON
//   returns: { ok: true, id, archive } on success
//            { ok: false, errors } on validation failure (400)
//            { ok: false, error: "internal" } on storage failure (500)
//
// The handler's contract: if it returns 200, the submission is durably
// captured (Vercel Blob OR local fs fallback). Email + Slack are
// best-effort and do NOT gate the success response.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { solveSubmissionSchema } from "@/lib/solve-schema";
import { rateLimit } from "@/lib/rate-limit";
import {
  persistSubmission,
  sendNotificationEmails,
  notifySlack,
} from "@/lib/solve-store";

export async function POST(req: Request) {
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent") ?? null;

  if (ipAddress && !rateLimit(ipAddress)) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  const parsed = solveSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "validation_failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const record = {
    ...parsed.data,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ipAddress,
    userAgent,
  };

  // Step 1: durable persistence (REQUIRED — fail closed).
  let archive;
  try {
    archive = await persistSubmission(record);
  } catch (err) {
    console.error("[solve-submit] persistence failed (both blob + local fs)", err);
    return NextResponse.json(
      { ok: false, error: "storage_unavailable" },
      { status: 500 },
    );
  }

  // Steps 2-3: best-effort backup channels (never block the success response).
  void Promise.allSettled([
    sendNotificationEmails(record),
    notifySlack(record),
  ]).then((results) => {
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("[solve-submit] best-effort notification failed", r.reason);
      }
    }
  });

  return NextResponse.json(
    { ok: true, id: record.id, archive: archive.destination },
    { status: 200 },
  );
}
