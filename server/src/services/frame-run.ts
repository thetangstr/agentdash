// AgentDash (co-worker slice 5a): which run an untrusted-document frame is
// bound to.
//
// A frame (document-content.ts) verifies, and is withheld from the stored log,
// only in the run it was minted for. The run id on a request comes from the
// `X-Paperclip-Run-Id` header, which the caller chooses, so it is not trusted
// as is: a frame minted for someone else's run would let the caller hide text
// (and, with no end marker, everything after it) from that run's stored log
// and live stream.
//
// - A person (board or session) never gets a frame that verifies: their own
//   output is not a run log, so the header is ignored and a stand-in id that
//   no run has is used.
// - An agent gets a frame for a run only when that run is one of its own live
//   runs in this company. A run JWT names its run, and a header naming another
//   is refused. While one of the agent's runs is running, only that run's id is
//   accepted (a queued run's frames would not verify in the running run's
//   log, so its text would be stored unstripped).
// - An agent that IS in a running run must say which; otherwise its text would
//   land unstripped in that run's log. Outside any running run (a steward's own
//   terminal using the agent key) nothing server-side records the output, so a
//   stand-in id is used.
//
// The same rule as the document-access reads (microsoft-documents.ts on the
// document-access branch); kept separate here so this slice stands alone.
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

export type FrameRunRefusal = {
  ok: false;
  status: 400 | 403;
  reason: "run_mismatch" | "run_id_required";
  message: string;
};

export type FrameRunResult = { ok: true; runId: string } | FrameRunRefusal;

/** Stand-in run id for a frame that must never verify in any run's log. */
export function standInFrameRunId(actorType: "agent" | "user", actorId: string): string {
  return `no-run:${actorType}:${actorId}`;
}

const NOT_YOUR_RUN = "The run id sent with this request is not one of your runs";

function mismatch(message: string): FrameRunRefusal {
  return { ok: false, status: 403, reason: "run_mismatch", message };
}

/**
 * The run an agent's framed text will land in, verified against
 * `heartbeat_runs`. `requestRunId` is the run id the request carries (header,
 * or the JWT's own run when no header was sent); `jwtRunId` is the run a run
 * JWT was signed for, when the credential is one.
 */
export async function frameRunForAgent(
  db: Db,
  input: { companyId: string; agentId: string; requestRunId: string | null | undefined; jwtRunId?: string | null },
): Promise<FrameRunResult> {
  const { companyId, agentId, requestRunId, jwtRunId } = input;
  if (jwtRunId && requestRunId !== jwtRunId) {
    return mismatch(
      "The run id sent with this request is not the run your credential was issued for; send $PAPERCLIP_RUN_ID as given",
    );
  }
  const runningRun = () =>
    db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")))
      .limit(1)
      .then((rows) => rows[0] ?? null);

  if (requestRunId) {
    if (!isUuidLike(requestRunId)) return mismatch(NOT_YOUR_RUN);
    const run = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, requestRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    if (!run) return mismatch(NOT_YOUR_RUN);
    if (run.status !== "running" && run.status !== "queued") {
      return mismatch("The run id sent with this request belongs to a run that has ended");
    }
    if (run.status === "queued" && (await runningRun())) {
      return mismatch(
        "The run id sent with this request is a queued run, not the run you are in; send $PAPERCLIP_RUN_ID as given",
      );
    }
    return { ok: true, runId: run.id };
  }
  if (await runningRun()) {
    return {
      ok: false,
      status: 400,
      reason: "run_id_required",
      message: "You are inside a run: send its id as the X-Paperclip-Run-Id header ($PAPERCLIP_RUN_ID) with this request",
    };
  }
  return { ok: true, runId: standInFrameRunId("agent", agentId) };
}
