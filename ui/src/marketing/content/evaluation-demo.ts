// AgentDash: fictional browser-only evidence, never a real customer or instance.
export const REPORT_SECTIONS = ["Delivery summary", "Financial position", "Risks & next actions"] as const;
export type EvidenceCaseKey = "supported" | "false-success" | "missing-proof" | "approval-block";
type EvidenceState = "supported" | "failed" | "unverified" | "blocked";
interface DemoCase {
  button: string; claim: string; status: string; state: EvidenceState;
  sections: readonly string[]; sources: number; total: number | null;
  receipts: readonly number[] | null; blocked?: boolean;
  note: string; explanation: string; observations: readonly string[];
}
export const EVIDENCE_CASES: Record<EvidenceCaseKey, DemoCase> = {
  supported: {
    button: "Evidence checks pass", claim: "DONE. The client update is ready.", status: "Evidence checked", state: "supported",
    sections: REPORT_SECTIONS, sources: 4, total: 48200, receipts: [36000, 12200],
    note: "The saved report contains all three agreed sections.",
    explanation: "These checks have supporting evidence. This is one input into evaluating the agent, not an overall performance score or a recorded owner decision.",
    observations: ["Saved-content receipt: revision 3 contains all three required section headings.", "Source register: four references are present in the saved report.", "Reconciliation receipt: $36,000 + $12,200 = $48,200; matches the reported total."],
  },
  "false-success": {
    button: "Convincing false success", claim: "DONE. All requirements are covered.", status: "False success detected", state: "failed",
    sections: REPORT_SECTIONS.slice(0, 2), sources: 4, total: 48200, receipts: [36000, 12200],
    note: "The required risks section is absent from the saved content. A confident completion claim does not change that fact.",
    explanation: "A required section is observably absent. That criterion fails even though the report looks polished and the agent says DONE.",
    observations: ["Saved-content receipt: revision 3 has two of the three agreed sections.", "Required-section comparison: Risks & next actions is absent from the saved content.", "Source and reconciliation receipts support their own checks; they do not cancel the missing section."],
  },
  "missing-proof": {
    button: "Missing proof", claim: "DONE. I checked the numbers.", status: "Unverified", state: "unverified",
    sections: REPORT_SECTIONS, sources: 4, total: 48200, receipts: null,
    note: "The reported total is visible. Its supporting reconciliation receipt is missing.",
    explanation: "The agent's statement is not a reconciliation receipt. Without underlying proof, the total stays unverified. Missing proof never becomes a passing check.",
    observations: ["Saved-content receipt: revision 3 contains all three required sections.", "Source register: four references are present.", "Reconciliation receipt: Not supplied. The total cannot be confirmed from the report alone."],
  },
  "approval-block": {
    button: "Approval required", claim: "Awaiting permission to retrieve the ledger.", status: "Approval blocked", state: "blocked",
    sections: REPORT_SECTIONS.slice(0, 1), sources: 1, total: null, receipts: null, blocked: true,
    note: "This is an incomplete draft. The agent waits for approval before accessing the ledger.",
    explanation: "The protected action remains blocked and the work is not complete. This is not a platform error or an accepted result. Action approval is separate from evaluating performance.",
    observations: ["Approval receipt: ledger access requires permission; approval is still pending.", "Execution receipt: Protected access was not attempted. No ledger data was retrieved.", "Saved-content receipt: revision 3 is incomplete; remaining checks cannot yet be assessed."],
  },
};
export const EVIDENCE_CASE_KEYS = Object.keys(EVIDENCE_CASES) as EvidenceCaseKey[];
export const demoMoney = (value: number | null) => value === null ? "Pending" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
export function evidenceChecks(item: DemoCase): Array<{ key: string; title: string; detail: string; state: EvidenceState }> {
  if (item.blocked) return [
    { key: "sections", title: "Three agreed sections", detail: "Incomplete draft; remaining work depends on approved access.", state: "blocked" },
    { key: "sources", title: "Four source references", detail: "Required information is not yet available to the agent.", state: "blocked" },
    { key: "total", title: "Total matches underlying receipts", detail: "The ledger was not retrieved. No reconciliation was performed.", state: "blocked" },
  ];
  const sectionsPresent = REPORT_SECTIONS.every(section => item.sections.includes(section));
  const total = item.receipts?.reduce((sum, value) => sum + value, 0);
  return [
    { key: "sections", title: "Three agreed sections", detail: sectionsPresent ? "Saved content includes summary, financial position, and risks with next actions." : "Risks & next actions is absent from the saved content. Two of three sections are present.", state: sectionsPresent ? "supported" : "failed" },
    { key: "sources", title: "Four source references", detail: `The saved report contains ${item.sources} source references; four are required.`, state: item.sources >= 4 ? "supported" : "failed" },
    { key: "total", title: "Total matches underlying receipts", detail: item.receipts ? `${item.receipts.map(demoMoney).join(" + ")} = ${demoMoney(total!)}. Reported total: ${demoMoney(item.total)}.` : "No reconciliation receipt was supplied. The agent's statement is not proof.", state: !item.receipts ? "unverified" : total === item.total ? "supported" : "failed" },
  ];
}
