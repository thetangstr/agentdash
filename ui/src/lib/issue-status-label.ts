/**
 * AgentDash (scan 4, lane O2): an issue status as a person would write it.
 * The Activity tab printed the stored values ("backlog → todo",
 * "in_progress"); these are the words the board uses everywhere else.
 */
const ISSUE_STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

export function issueStatusLabel(status: string | null | undefined): string {
  const value = (status ?? "").trim();
  if (!value) return "None";
  const known = ISSUE_STATUS_LABELS[value];
  if (known) return known;
  const words = value.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
