interface Activity { kind: string; agentId: string; payload?: Record<string, unknown> }
interface Classification { chatWorthy: boolean; summary?: string; severity?: "info" | "warn" | "blocked" }

const CHAT_WORTHY: Set<string> = new Set([
  "task_completed", "blocker_raised", "approval_requested", "agent_paused",
]);

export function activityRouter() {
  return {
    classify: (a: Activity): Classification => {
      if (!CHAT_WORTHY.has(a.kind)) return { chatWorthy: false };
      const summary = summarize(a);
      const severity = a.kind === "blocker_raised" ? "blocked" : a.kind === "agent_paused" ? "warn" : "info";
      return { chatWorthy: true, summary, severity };
    },
  };
}

function summarize(a: Activity): string {
  const p = a.payload ?? {};
  switch (a.kind) {
    case "task_completed": return `${p.title ?? "Completed a task"}.`;
    case "blocker_raised": return `Blocked: ${p.reason ?? "unknown"}.`;
    case "approval_requested": return `Needs approval: ${p.title ?? "action"}.`;
    case "agent_paused": return `Paused (${p.reason ?? "manual"}).`;
    default: return "Update.";
  }
}
