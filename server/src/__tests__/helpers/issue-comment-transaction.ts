import { getTableName } from "drizzle-orm";

// Compatibility fixtures still mock service behavior. Model the composer's
// new company/issue SELECT + FOR UPDATE interface explicitly; real transaction
// atomicity, lock order and rollback are exercised in the PostgreSQL suite.
export function commentTransactionReads(getIssue: () => Promise<any>, getRun: (id?: string) => Promise<any> = async () => null) {
  return {
    select() {
      let tableName: string;
      const query = {
        from(table: any) { tableName = getTableName(table); return query; },
        innerJoin() { return query; },
        leftJoin() { return query; },
        where() { return query; },
        for(mode: string) { if (mode !== "update" && mode !== "no key update") throw new Error("Unexpected lock mode"); return query; },
        orderBy() { return query; },
        limit() { return query; },
        async then(resolve: (rows: any[]) => unknown, reject?: (error: unknown) => unknown) {
          try {
            if (tableName === "companies") return resolve([{ id: (await getIssue()).companyId }]);
            if (tableName === "feature_flags") return resolve([]);
            if (tableName === "issue_thread_interactions") return resolve([]);
            if (tableName === "issues") return resolve([await getIssue()]);
            // AgentDash (batch 2 review lane): these fixtures hold no work
            // products and no issue documents — the same emptiness the write
            // stub below already assumes.
            if (tableName === "issue_work_products") return resolve([]);
            if (tableName === "issue_documents" || tableName === "documents") return resolve([]);
            if (tableName === "heartbeat_runs") {
              const run = await getRun((await getIssue()).executionRunId);
              // The real close-out queries only pick live runs; a finished
              // run would not be selected for cancellation.
              const liveStatuses = ["queued", "running", "scheduled_retry"];
              return resolve(run && liveStatuses.includes(run.status) ? [run] : []);
            }
            throw new Error(`Unexpected comment acceptance read: ${tableName}`);
          } catch (error) { if (reject) return reject(error); throw error; }
        },
      };
      return query;
    },
  };
}

// PATCH compatibility suites inject the same canonical services through the
// index module. Wire their direct composer imports to those explicit doubles.
export async function installPatchServiceMocks() {
  const { vi } = await import("vitest");
  vi.doMock("../../services/cos-verdict-orchestrator.js", () => ({ cosVerdictOrchestrator: () => ({ onIssueStatusChanged: async () => undefined }) }));
  vi.doMock("../../services/issues.js", async () => ({ issueService: (await import("../../services/index.js")).issueService }));
  vi.doMock("../../services/agents.js", async () => ({ agentService: (await import("../../services/index.js")).agentService }));
  vi.doMock("../../services/issue-references.js", async () => ({ issueReferenceService: (await import("../../services/index.js")).issueReferenceService }));
  vi.doMock("../../services/routines.js", async () => ({ routineService: (await import("../../services/index.js")).routineService }));
  vi.doMock("../../services/issue-thread-interactions.js", async () => {
    const index = await import("../../services/index.js");
    return { issueThreadInteractionService: Object.prototype.hasOwnProperty.call(index, "issueThreadInteractionService")
      ? index.issueThreadInteractionService : () => ({ expireRequestConfirmationsSupersededByComment: async () => [] }) };
  });
  vi.doMock("../../services/activity-log.js", async () => {
    const { logActivity } = await import("../../services/index.js");
    return { logActivity, insertActivity: async (tx: any, input: any) => { await logActivity(tx, input); return {}; }, publishActivity: vi.fn() };
  });
}

// AgentDash (MVP launch lane B): a board move to or from done updates the
// issue's work products in the same transaction. These fixtures hold none, so
// the update matches no rows; any other table is a surprise.
function emptyWorkProductUpdate(table: any) {
  if (getTableName(table) !== "issue_work_products") throw new Error(`Unexpected patch acceptance write: ${getTableName(table)}`);
  const chain = { set: () => chain, where: () => chain, returning: async () => [] };
  return chain;
}

export function patchTransactionFixture(getIssue: () => Promise<any>, getRun?: () => Promise<any>) {
  const reads = commentTransactionReads(getIssue, getRun);
  return { ...reads, transaction: async (callback: (tx: unknown) => unknown) => callback({ ...reads, insert: () => ({ values: async () => undefined }), update: emptyWorkProductUpdate }) };
}
