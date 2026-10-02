// AgentDash (GH #785, UX-4): the readiness assessment is optional. It left the
// signup chain and lives here, in Settings (Assessment), for anyone who wants
// it. Same card for every company (one UX).
import { Button } from "@/components/ui/button";

export function ReadinessAssessmentCard() {
  return (
    <div className="space-y-4" data-testid="company-settings-advanced-section">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Assessment</div>
      <div className="rounded-md border border-border px-4 py-4">
        <div className="text-sm font-medium">Readiness assessment</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Optional. Five questions about your team, then a short report on where AI agents can help first. Your
          answers are saved to this workspace, and you can run it again any time.
        </p>
        <div className="mt-3">
          <Button size="sm" variant="outline" asChild>
            <a href="/assess">Run the assessment</a>
          </Button>
        </div>
      </div>
    </div>
  );
}
