import { getTableName } from "drizzle-orm";

// Compatibility fixtures still mock service behavior. Model the composer's
// new company/issue SELECT + FOR UPDATE interface explicitly; real transaction
// atomicity, lock order and rollback are exercised in the PostgreSQL suite.
export function commentTransactionReads(getIssue: () => Promise<any>, getRun: () => Promise<any> = async () => null) {
  return {
    select() {
      let tableName: string;
      const query = {
        from(table: any) { tableName = getTableName(table); return query; },
        where() { return query; },
        for(mode: string) { if (mode !== "update") throw new Error("Unexpected lock mode"); return query; },
        orderBy() { return query; },
        limit() { return query; },
        async then(resolve: (rows: any[]) => unknown, reject?: (error: unknown) => unknown) {
          try {
            if (tableName === "companies") return resolve([{ id: (await getIssue()).companyId }]);
            if (tableName === "issue_thread_interactions") return resolve([]);
            if (tableName === "issues") return resolve([await getIssue()]);
            if (tableName === "heartbeat_runs") { const run = await getRun(); return resolve(run ? [run] : []); }
            throw new Error(`Unexpected comment acceptance read: ${tableName}`);
          } catch (error) { if (reject) return reject(error); throw error; }
        },
      };
      return query;
    },
  };
}
