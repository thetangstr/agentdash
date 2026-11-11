import type { FredBriefContent } from "@paperclipai/shared";

export function renderFredBrief(brief: FredBriefContent, revision: number) {
 const unknown = (v: string) => v || "Not measured / unknown";
 return `# Company-shared adoption brief — revision ${revision}

## Desired result
${brief.goal}

## First useful job
${brief.firstJob}

## Acceptance criteria
${brief.successCriteria.map(x => "- " + x).join("\n")}

## Baseline
${unknown(brief.baseline)}

## Target
${unknown(brief.target)}

## Outcome observation window
${unknown(brief.outcomeWindow)}

## Boundaries
${brief.boundaries || "No additional authority granted. Existing permissions and approval gates apply."}

Owner acceptance: not recorded here.
Business outcome: not established by this brief.
Human correction effort: not measured.
`;
}

// A label or matching revision without the approved bytes is not proof.
export function hasCurrentFredBrief(
 document: { latestRevisionId: string | null; body?: string } | null | undefined,
 approvedRevisionId: string | null,
 brief: FredBriefContent,
 revision: number,
): boolean {
 return Boolean(approvedRevisionId && document && document.latestRevisionId === approvedRevisionId && document.body === renderFredBrief(brief, revision));
}

export function renderFredDiscoveryDescription(brief: FredBriefContent, revision: number, documentRevisionId: string | null): string {
 return renderFredBrief(brief, revision) + "\nPinned native adoption revision: " + documentRevisionId + "\nDiscovery produces a recommendation, not owner acceptance or a measured business result.";
}
