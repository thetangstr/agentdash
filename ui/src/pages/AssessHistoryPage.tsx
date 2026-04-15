import { useCompany } from "../context/CompanyContext";
import { useQuery } from "@tanstack/react-query";
import { assessApi } from "../api/assess";
import { queryKeys } from "../lib/queryKeys";
import { useNavigate } from "../lib/router";

export function AssessHistoryPage() {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.agentResearch.assessment(selectedCompanyId!),
    queryFn: () => assessApi.getAssessment(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;

  if (!data) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <h2 className="text-lg font-semibold">No assessments yet</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Run your first Agent Readiness Assessment to see results here.
        </p>
        <button
          className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white"
          onClick={() => navigate("../assess")}
        >
          Start Assessment
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Assessment Results</h1>
        <button
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
          onClick={() => navigate("../assess")}
        >
          New Assessment
        </button>
      </div>
      <div className="prose prose-sm max-w-none rounded-lg border border-border bg-card p-6">
        <div dangerouslySetInnerHTML={{ __html: simpleMarkdownToHtml(data.markdown) }} />
      </div>
      {data.jumpstart && (
        <details className="mt-4 rounded-lg border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm font-medium">Jumpstart File</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
            {data.jumpstart}
          </pre>
        </details>
      )}
    </div>
  );
}

function simpleMarkdownToHtml(md: string): string {
  return md
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br/>");
}
