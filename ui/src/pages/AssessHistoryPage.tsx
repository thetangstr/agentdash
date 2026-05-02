import { useCompany } from "../context/CompanyContext";
import { useQuery } from "@tanstack/react-query";
import { assessApi } from "../api/assess";
import { queryKeys } from "../lib/queryKeys";
import { useNavigate } from "../lib/router";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarketingShell } from "../marketing/MarketingShell";
import { Button } from "../marketing/components/Button";

export function AssessHistoryPage() {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.agentResearch.assessment(selectedCompanyId!),
    queryFn: () => assessApi.getAssessment(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (isLoading) {
    return (
      <MarketingShell>
        <div className="p-6 text-sm" style={{ color: "var(--mkt-ink-soft)" }}>Loading...</div>
      </MarketingShell>
    );
  }

  if (!data) {
    return (
      <MarketingShell>
        <div className="mx-auto max-w-xl py-16 text-center">
          <h2 className="mkt-display-section" style={{ fontSize: "1.5rem" }}>No assessments yet</h2>
          <p className="mt-2 text-sm" style={{ color: "var(--mkt-ink-soft)" }}>
            Run your first Agent Readiness Assessment to see results here.
          </p>
          <div className="mt-4 flex justify-center">
            <Button onClick={() => navigate("../assess")}>
              Start Assessment
            </Button>
          </div>
        </div>
      </MarketingShell>
    );
  }

  return (
    <MarketingShell>
      <div className="mx-auto max-w-4xl p-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="mkt-display-section" style={{ fontSize: "1.75rem", margin: 0 }}>Assessment Results</h1>
          <Button onClick={() => navigate("../assess")}>
            New Assessment
          </Button>
        </div>
        <div
          className="rounded-lg p-6"
          style={{ background: "var(--mkt-surface-cream-2)", border: "1px solid var(--mkt-rule)" }}
        >
          <MarkdownBody>{data.markdown}</MarkdownBody>
        </div>
        {data.jumpstart && (
          <details
            className="mt-4 rounded-lg p-4"
            style={{ background: "var(--mkt-surface-cream-2)", border: "1px solid var(--mkt-rule)" }}
          >
            <summary className="cursor-pointer text-sm font-medium">Jumpstart File</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs" style={{ color: "var(--mkt-ink-soft)" }}>
              {data.jumpstart}
            </pre>
          </details>
        )}
      </div>
    </MarketingShell>
  );
}
