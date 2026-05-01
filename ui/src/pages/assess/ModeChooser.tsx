// AgentDash: ModeChooser — top-of-page mode selector for /assess.
// Lets the user choose between assessing the entire company or a specific project.
import { Building2, Target } from "lucide-react";

export type AssessmentMode = "company" | "project";

export interface ModeChooserProps {
  onPick: (mode: AssessmentMode) => void;
}

export function ModeChooser({ onPick }: ModeChooserProps) {
  return (
    <div className="mkt-assess__mode-grid">
      <button
        type="button"
        className="mkt-assess__mode-card"
        onClick={() => onPick("company")}
      >
        <span className="mkt-assess__mode-icon">
          <Building2 size={22} strokeWidth={1.75} aria-hidden />
        </span>
        <h3 className="mkt-assess__mode-title">Assess the entire company</h3>
        <p className="mkt-assess__mode-desc">
          A four-step readiness scan across industry, operations, functions, and goals.
          Produces a tailored agent deployment proposal grounded in our research data.
        </p>
        <span className="mkt-assess__mode-cta">Start company assessment →</span>
      </button>

      <button
        type="button"
        className="mkt-assess__mode-card"
        onClick={() => onPick("project")}
      >
        <span className="mkt-assess__mode-icon">
          <Target size={22} strokeWidth={1.75} aria-hidden />
        </span>
        <h3 className="mkt-assess__mode-title">Assess a specific project</h3>
        <p className="mkt-assess__mode-desc">
          Scoped to a single agent project. Adaptive clarifying questions, a
          phased rollout plan, and a downloadable Word doc you can share with the team.
        </p>
        <span className="mkt-assess__mode-cta">Start project assessment →</span>
      </button>
    </div>
  );
}
