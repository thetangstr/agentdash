// AgentDash: Reusable wizard chrome shared by CompanyWizard and ProjectWizard.
// Extracted from AssessPage.tsx — visible behavior is unchanged.
import { CheckCircle2, Loader2, RotateCcw, Sparkles } from "lucide-react";
import type { ComponentType } from "react";
import { Button } from "../../marketing/components/Button";
import { Eyebrow } from "../../marketing/components/Eyebrow";
import { MarkdownBody } from "../../components/MarkdownBody";

/* ------------------------------------------------------------------ */
/*  StepIndicator                                                      */
/* ------------------------------------------------------------------ */

export interface StepDef {
  num: number;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

export function StepIndicator({
  step,
  steps,
  onJump,
}: {
  step: number;
  steps: StepDef[];
  onJump: (n: number) => void;
}) {
  return (
    <div className="mkt-assess__steps">
      {steps.map((s) => {
        const Icon = s.icon;
        const isActive = s.num === step;
        const isDone = s.num < step;
        const isClickable = s.num < step;
        return (
          <button
            key={s.num}
            type="button"
            onClick={() => isClickable && onJump(s.num)}
            className={`mkt-assess__step ${isActive ? "mkt-assess__step--active" : ""} ${isDone ? "mkt-assess__step--done" : ""}`}
            style={{ cursor: isClickable ? "pointer" : "default" }}
            aria-current={isActive ? "step" : undefined}
            aria-label={`Step ${s.num}: ${s.label}`}
          >
            {isDone ? <CheckCircle2 size={14} strokeWidth={1.75} /> : <Icon size={14} strokeWidth={1.75} />}
            <span>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  WizardCard                                                         */
/* ------------------------------------------------------------------ */

export function WizardCard({ children }: { children: React.ReactNode }) {
  return <div className="mkt-assess__card">{children}</div>;
}

/* ------------------------------------------------------------------ */
/*  StepHeading                                                        */
/* ------------------------------------------------------------------ */

export function StepHeading({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 className="mkt-display-section" style={{ fontSize: 32, marginBottom: 8 }}>{title}</h2>
      <p className="mkt-caption" style={{ fontSize: 15 }}>{sub}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Field                                                              */
/* ------------------------------------------------------------------ */

export function Field({
  label, value, onChange, placeholder, multiline, rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  multiline?: boolean;
  rows?: number;
}) {
  const common = {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    placeholder,
    className: "mkt-assess__input",
  };
  return (
    <div>
      <label className="mkt-assess__label">{label}</label>
      {multiline ? <textarea {...common} rows={rows ?? 3} /> : <input {...common} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ChipRow                                                            */
/* ------------------------------------------------------------------ */

export function ChipRow({
  options,
  value,
  onSelect,
}: {
  options: readonly string[];
  value: string;
  onSelect: (v: string) => void;
}) {
  return (
    <div className="mkt-assess__chips">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onSelect(opt)}
          className={`mkt-assess__chip ${value === opt ? "mkt-assess__chip--selected" : ""}`}
        >{opt}</button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  RadioOption                                                        */
/* ------------------------------------------------------------------ */

export function RadioOption({
  selected, onClick, title, desc,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mkt-assess__radio ${selected ? "mkt-assess__radio--selected" : ""}`}
    >
      <div className="mkt-assess__radio-title">{title}</div>
      <div className="mkt-assess__radio-desc">{desc}</div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  SmallRadioGroup                                                    */
/* ------------------------------------------------------------------ */

export function SmallRadioGroup({
  label, options, value, onSelect,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onSelect: (v: string) => void;
}) {
  return (
    <div>
      <div className="mkt-assess__sub-label">{label}</div>
      <div style={{ display: "grid", gap: 6 }}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onSelect(opt.value)}
            className={`mkt-assess__small-radio ${value === opt.value ? "mkt-assess__small-radio--selected" : ""}`}
          >{opt.label}</button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ResultsHeader                                                      */
/* ------------------------------------------------------------------ */

export function ResultsHeader({
  title,
  eyebrow,
  badges,
  isStreaming,
  onReset,
  onCancel,
  extraActions,
}: {
  title: string;
  eyebrow: string;
  badges: string[];
  isStreaming: boolean;
  onReset: () => void;
  onCancel: () => void;
  extraActions?: React.ReactNode;
}) {
  return (
    <div className="mkt-assess__results-head">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="mkt-display-section" style={{ fontSize: 32, marginTop: 8 }}>{title}</h2>
        {badges.length > 0 && (
          <div className="mkt-assess__badges">
            {badges.map((b) => <span key={b} className="mkt-assess__badge">{b}</span>)}
          </div>
        )}
      </div>
      <div className="mkt-assess__results-actions">
        {extraActions}
        <Button variant="ghost" onClick={onReset}>
          <RotateCcw size={14} strokeWidth={1.75} aria-hidden /> New
        </Button>
        {isStreaming && (
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ReportPanel                                                        */
/* ------------------------------------------------------------------ */

export function ReportPanel({
  output,
  error,
  isStreaming,
  reportLabel,
  loadingLabel,
}: {
  output: string;
  error: string;
  isStreaming: boolean;
  reportLabel: string;
  loadingLabel?: string;
}) {
  return (
    <div className="mkt-assess__card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="mkt-assess__report-head">
        <Sparkles size={14} strokeWidth={1.75} aria-hidden style={{ color: "var(--mkt-accent)" }} />
        <span>{reportLabel}</span>
      </div>
      <div className="mkt-assess__report-body">
        {error && (
          <div className="mkt-assess__error" role="alert">
            <strong>Error:</strong> {error}
          </div>
        )}
        {!output && !error && (
          <div className="mkt-assess__loading" aria-live="polite">
            <Loader2 size={16} className="mkt-assess__spin" />
            <span>{loadingLabel ?? "Retrieving research data and generating the assessment…"}</span>
          </div>
        )}
        {output && (
          <div className="mkt-assess__report">
            <MarkdownBody>{output}</MarkdownBody>
            {isStreaming && (
              <div className="mkt-assess__streaming-tail" aria-live="polite">
                <Loader2 size={14} className="mkt-assess__spin" />
                <span>Streaming…</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AssessLocalStyles — page-local styles shared by both wizards       */
/* ------------------------------------------------------------------ */

export function AssessLocalStyles() {
  return (
    <style>{`
      .mkt-assess__steps { display: flex; gap: 4px; margin-bottom: 24px; flex-wrap: wrap; }
      .mkt-assess__step {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 10px 14px; border-radius: 8px; border: none; background: transparent;
        font-family: var(--mkt-font-sans); font-size: 13px; font-weight: 500;
        color: var(--mkt-ink-soft); transition: background-color 160ms var(--mkt-ease);
      }
      .mkt-assess__step--active { background: var(--mkt-surface-cream-2); color: var(--mkt-ink); }
      .mkt-assess__step--done { color: var(--mkt-accent-ink); }
      .mkt-assess__card {
        background: #fff; border: 1px solid var(--mkt-rule); border-radius: 16px;
        padding: 40px; box-shadow: 0 4px 24px -16px rgba(31,30,29,0.12);
      }
      .mkt-assess__nav {
        display: flex; align-items: center; justify-content: space-between;
        gap: 16px; margin-top: 32px; padding-top: 24px;
        border-top: 1px solid var(--mkt-rule);
      }
      .mkt-assess__grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      .mkt-assess__grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
      @media (max-width: 800px) {
        .mkt-assess__grid-2 { grid-template-columns: 1fr; }
        .mkt-assess__grid-3 { grid-template-columns: 1fr; }
      }
      .mkt-assess__label {
        display: block; margin-bottom: 6px;
        font-size: 12px; font-weight: 600; color: var(--mkt-ink);
        font-family: var(--mkt-font-sans);
      }
      .mkt-assess__sub-label {
        font-family: var(--mkt-font-mono); font-size: 11px; font-weight: 500;
        text-transform: uppercase; letter-spacing: 0.1em;
        color: var(--mkt-ink-soft); margin-bottom: 8px;
      }
      .mkt-assess__count {
        font-family: var(--mkt-font-mono); font-weight: 400;
        color: var(--mkt-accent-ink);
      }
      .mkt-assess__hint {
        margin-left: 12px; padding: 2px 8px; border-radius: 999px;
        font-size: 11px; color: var(--mkt-accent-ink);
        background: var(--mkt-surface-cream-2); border: 1px solid var(--mkt-rule);
      }
      .mkt-assess__divider {
        display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
        padding-top: 16px; border-top: 1px solid var(--mkt-rule);
      }
      .mkt-assess__input, .mkt-assess__select {
        width: 100%; padding: 10px 12px; border-radius: 8px;
        border: 1px solid var(--mkt-rule); background: #fff;
        font-family: var(--mkt-font-sans); font-size: 14px; color: var(--mkt-ink);
        transition: border-color 160ms var(--mkt-ease);
      }
      .mkt-assess__input:focus, .mkt-assess__select:focus {
        outline: none; border-color: var(--mkt-accent);
      }
      textarea.mkt-assess__input { min-height: 80px; resize: vertical; }
      .mkt-assess__chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .mkt-assess__chip {
        padding: 7px 14px; border-radius: 999px;
        background: transparent; color: var(--mkt-ink-soft);
        border: 1px solid var(--mkt-rule);
        font-size: 13px; font-weight: 500; cursor: pointer;
        transition: all 160ms var(--mkt-ease);
      }
      .mkt-assess__chip:hover { color: var(--mkt-ink); border-color: var(--mkt-ink-soft); }
      .mkt-assess__chip--selected,
      .mkt-assess__chip--selected:hover {
        background: var(--mkt-accent); color: #fff;
        border-color: var(--mkt-accent);
      }
      .mkt-assess__group-tag {
        font-family: var(--mkt-font-mono); font-size: 10px; font-weight: 500;
        text-transform: uppercase; letter-spacing: 0.1em;
        color: var(--mkt-ink-soft); margin-bottom: 6px;
      }
      .mkt-assess__radio {
        text-align: left; padding: 14px 16px; border-radius: 10px;
        border: 1px solid var(--mkt-rule); background: transparent;
        cursor: pointer; transition: all 160ms var(--mkt-ease);
      }
      .mkt-assess__radio:hover { border-color: var(--mkt-ink-soft); }
      .mkt-assess__radio--selected,
      .mkt-assess__radio--selected:hover {
        border: 2px solid var(--mkt-accent);
        background: var(--mkt-surface-cream-2);
        padding: 13px 15px;
      }
      .mkt-assess__radio-title {
        font-size: 14px; font-weight: 600; color: var(--mkt-ink);
      }
      .mkt-assess__radio-desc {
        margin-top: 4px; font-size: 12px; color: var(--mkt-ink-soft);
      }
      .mkt-assess__small-radio {
        text-align: left; padding: 10px 12px; border-radius: 8px;
        border: 1px solid var(--mkt-rule); background: transparent;
        font-family: var(--mkt-font-sans); font-size: 13px; color: var(--mkt-ink);
        cursor: pointer; transition: all 160ms var(--mkt-ease);
      }
      .mkt-assess__small-radio:hover { border-color: var(--mkt-ink-soft); }
      .mkt-assess__small-radio--selected,
      .mkt-assess__small-radio--selected:hover {
        border: 2px solid var(--mkt-accent);
        background: var(--mkt-surface-cream-2);
        padding: 9px 11px;
      }
      .mkt-assess__fn-group {
        border: 1px solid var(--mkt-rule); border-radius: 10px; padding: 14px;
      }
      .mkt-assess__fn-group-tag {
        font-family: var(--mkt-font-mono); font-size: 11px; font-weight: 500;
        text-transform: uppercase; letter-spacing: 0.1em;
        color: var(--mkt-ink); margin-bottom: 10px;
      }
      .mkt-assess__fn-row {
        display: flex; align-items: center; gap: 8px;
        width: 100%; padding: 6px 8px; border-radius: 6px;
        background: transparent; border: none;
        font-family: var(--mkt-font-sans); font-size: 13px; color: var(--mkt-ink-soft);
        text-align: left; cursor: pointer; transition: background-color 160ms var(--mkt-ease);
      }
      .mkt-assess__fn-row:hover { background: var(--mkt-surface-cream-2); }
      .mkt-assess__fn-row--selected {
        background: var(--mkt-surface-cream-2);
        color: var(--mkt-ink); font-weight: 600;
      }
      .mkt-assess__fn-check {
        width: 14px; height: 14px; border-radius: 4px; flex-shrink: 0;
        border: 1.5px solid var(--mkt-rule); display: inline-flex;
        align-items: center; justify-content: center;
      }
      .mkt-assess__fn-check--selected {
        border: none; background: var(--mkt-accent); color: #fff;
      }
      .mkt-assess__count-line {
        margin-top: 12px; font-size: 13px; color: var(--mkt-accent-ink);
      }
      .mkt-assess__results-head {
        display: flex; align-items: flex-start; justify-content: space-between;
        gap: 24px; margin-bottom: 24px; flex-wrap: wrap;
      }
      .mkt-assess__results-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .mkt-assess__badges {
        display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px;
      }
      .mkt-assess__badge {
        padding: 4px 10px; border-radius: 999px;
        font-family: var(--mkt-font-mono); font-size: 11px;
        background: var(--mkt-surface-cream-2);
        color: var(--mkt-accent-ink);
        border: 1px solid var(--mkt-rule);
      }
      .mkt-assess__report-head {
        display: flex; align-items: center; gap: 8px;
        padding: 14px 24px;
        border-bottom: 1px solid var(--mkt-rule);
        background: var(--mkt-surface-cream-2);
        font-family: var(--mkt-font-mono); font-size: 11px; font-weight: 500;
        text-transform: uppercase; letter-spacing: 0.1em;
        color: var(--mkt-ink);
      }
      .mkt-assess__report-body {
        padding: 32px; max-height: 75vh; overflow: auto;
      }
      .mkt-assess__report :is(h1, h2, h3, h4) {
        font-family: var(--mkt-font-serif); color: var(--mkt-ink);
      }
      .mkt-assess__report h1 { font-size: 32px; margin: 24px 0 12px; line-height: 1.15; }
      .mkt-assess__report h2 { font-size: 26px; margin: 32px 0 12px; line-height: 1.2;
        padding-bottom: 6px; border-bottom: 2px solid var(--mkt-rule); }
      .mkt-assess__report h3 { font-size: 19px; margin: 24px 0 8px; color: var(--mkt-accent-ink); }
      .mkt-assess__report p { margin: 8px 0; line-height: 1.6; }
      .mkt-assess__report ul, .mkt-assess__report ol { margin: 12px 0; padding-left: 24px; }
      .mkt-assess__report li { margin: 4px 0; line-height: 1.55; }
      .mkt-assess__report strong { color: var(--mkt-ink); font-weight: 600; }
      .mkt-assess__report code {
        font-family: var(--mkt-font-mono); font-size: 0.9em;
        background: var(--mkt-surface-cream-2); padding: 2px 6px; border-radius: 4px;
      }
      .mkt-assess__error {
        margin-bottom: 16px; padding: 12px 16px; border-radius: 8px;
        background: #fdecea; color: #9a2418; border: 1px solid #f5b8b1;
        font-size: 13px;
      }
      .mkt-assess__loading {
        display: flex; align-items: center; gap: 10px; padding: 32px;
        justify-content: center; color: var(--mkt-ink-soft); font-size: 14px;
      }
      .mkt-assess__streaming-tail {
        display: inline-flex; align-items: center; gap: 8px; margin-top: 16px;
        font-family: var(--mkt-font-mono); font-size: 12px; color: var(--mkt-accent-ink);
      }
      .mkt-assess__spin {
        animation: mkt-assess-spin 1.1s linear infinite;
      }
      @keyframes mkt-assess-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .mkt-assess__jumpstart { margin-top: 24px; }
      .mkt-assess__jumpstart > summary {
        cursor: pointer; padding: 8px 0;
        font-family: var(--mkt-font-mono); font-size: 12px; font-weight: 500;
        text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--mkt-accent-ink);
      }

      /* AgentDash: ModeChooser cards */
      .mkt-assess__mode-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 20px;
        margin-top: 32px;
      }
      @media (max-width: 800px) {
        .mkt-assess__mode-grid { grid-template-columns: 1fr; }
      }
      .mkt-assess__mode-card {
        text-align: left; padding: 28px 28px 24px; border-radius: 14px;
        border: 1px solid var(--mkt-rule); background: #fff;
        cursor: pointer; transition: all 200ms var(--mkt-ease);
        display: flex; flex-direction: column; gap: 12px;
        box-shadow: 0 4px 24px -16px rgba(31,30,29,0.08);
      }
      .mkt-assess__mode-card:hover {
        border-color: var(--mkt-accent); transform: translateY(-2px);
        box-shadow: 0 12px 36px -20px rgba(31,30,29,0.18);
      }
      .mkt-assess__mode-icon {
        width: 44px; height: 44px; border-radius: 12px;
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--mkt-surface-cream-2); color: var(--mkt-accent-ink);
      }
      .mkt-assess__mode-title {
        font-family: var(--mkt-font-serif); font-size: 22px;
        color: var(--mkt-ink); line-height: 1.25;
      }
      .mkt-assess__mode-desc {
        font-size: 14px; color: var(--mkt-ink-soft); line-height: 1.5;
      }
      .mkt-assess__mode-cta {
        margin-top: 8px;
        font-family: var(--mkt-font-mono); font-size: 12px;
        text-transform: uppercase; letter-spacing: 0.1em;
        color: var(--mkt-accent-ink);
      }

      /* AgentDash: Progress bar (one-at-a-time question stepper) */
      .mkt-assess__progress {
        display: flex; align-items: center; gap: 12px;
        margin-bottom: 20px;
      }
      .mkt-assess__progress-bar {
        flex: 1; height: 4px; border-radius: 2px;
        background: var(--mkt-rule); overflow: hidden;
      }
      .mkt-assess__progress-fill {
        height: 100%; border-radius: 2px;
        background: var(--mkt-accent);
        transition: width 300ms var(--mkt-ease);
      }
      .mkt-assess__progress-label {
        flex-shrink: 0;
        font-family: var(--mkt-font-mono); font-size: 11px;
        color: var(--mkt-ink-soft); white-space: nowrap;
      }

      /* AgentDash: Option chips (guided answers on clarify questions) */
      .mkt-assess__option-chips {
        display: flex; flex-wrap: wrap; gap: 8px;
        margin-bottom: 12px;
      }
      .mkt-assess__option-chip {
        padding: 8px 16px; border-radius: 10px;
        background: #fff; color: var(--mkt-ink);
        border: 1px solid var(--mkt-rule);
        font-family: var(--mkt-font-sans); font-size: 13px;
        cursor: pointer; text-align: left; line-height: 1.4;
        transition: all 160ms var(--mkt-ease);
      }
      .mkt-assess__option-chip:hover {
        border-color: var(--mkt-accent); color: var(--mkt-accent-ink);
      }
      .mkt-assess__option-chip--selected,
      .mkt-assess__option-chip--selected:hover {
        background: var(--mkt-accent); color: #fff;
        border-color: var(--mkt-accent);
      }

      /* AgentDash: Clarity meter (review phase) */
      .mkt-assess__clarity {
        margin-bottom: 24px;
        display: flex; align-items: center; gap: 12px;
      }
      .mkt-assess__clarity-bar {
        flex: 1; height: 6px; border-radius: 3px;
        background: var(--mkt-rule); overflow: hidden;
      }
      .mkt-assess__clarity-fill {
        height: 100%; border-radius: 3px;
        transition: width 400ms var(--mkt-ease), background-color 400ms var(--mkt-ease);
      }
      .mkt-assess__clarity-label {
        flex-shrink: 0;
        font-family: var(--mkt-font-mono); font-size: 11px;
        color: var(--mkt-ink-soft); white-space: nowrap;
      }

      /* AgentDash: Review list (compact answer summary) */
      .mkt-assess__review-list {
        display: grid; gap: 2px; margin-bottom: 8px;
      }
      .mkt-assess__review-item {
        display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
        padding: 10px 14px; border-radius: 8px;
        cursor: pointer; transition: background-color 160ms var(--mkt-ease);
      }
      .mkt-assess__review-item:hover {
        background: var(--mkt-surface-cream-2);
      }
      .mkt-assess__review-q {
        font-size: 13px; font-weight: 500; color: var(--mkt-ink);
        line-height: 1.4;
      }
      .mkt-assess__review-a {
        font-size: 13px; color: var(--mkt-ink-soft); line-height: 1.4;
        overflow: hidden; text-overflow: ellipsis;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      }
      .mkt-assess__review-a--empty {
        font-style: italic; color: var(--mkt-rule);
      }
      @media (max-width: 800px) {
        .mkt-assess__review-item { grid-template-columns: 1fr; }
        .mkt-assess__clarity { flex-direction: column; align-items: stretch; }
        .mkt-assess__clarity-label { white-space: normal; }
      }

      /* AgentDash: Project clarify questions panel */
      .mkt-assess__clarify {
        margin-top: 24px; padding: 28px;
        background: var(--mkt-surface-cream-2);
        border: 1px solid var(--mkt-rule); border-radius: 14px;
      }
      .mkt-assess__clarify-q {
        margin-bottom: 18px; padding-bottom: 18px;
        border-bottom: 1px dashed var(--mkt-rule);
      }
      .mkt-assess__clarify-q:last-child {
        border-bottom: none; margin-bottom: 0; padding-bottom: 0;
      }
      .mkt-assess__clarify-q-title {
        font-family: var(--mkt-font-serif); font-size: 17px;
        color: var(--mkt-ink); margin-bottom: 4px; line-height: 1.35;
      }
      .mkt-assess__clarify-q-hint {
        font-size: 12px; color: var(--mkt-ink-soft); margin-bottom: 10px;
        font-style: italic;
      }
      .mkt-assess__clarify-rephrased {
        margin-bottom: 20px; padding: 14px 16px; border-radius: 10px;
        background: #fff; border: 1px solid var(--mkt-rule);
        font-family: var(--mkt-font-serif); font-size: 15px;
        line-height: 1.5; color: var(--mkt-ink);
      }
      .mkt-assess__clarify-rephrased::before {
        content: "We heard:"; display: block;
        font-family: var(--mkt-font-mono); font-size: 10px; font-weight: 500;
        text-transform: uppercase; letter-spacing: 0.1em;
        color: var(--mkt-accent-ink); margin-bottom: 6px;
      }
    `}</style>
  );
}
