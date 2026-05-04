// AgentDash: CompanyWizard — the original 4-step wizard extracted from
// AssessPage.tsx. Behavior must remain identical to the previous /assess flow.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cpu,
  RotateCcw,
  Settings,
  Sparkles,
  Target,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { assessApi, type StoredAssessment } from "../../api/assess";
import { MarkdownBody } from "../../components/MarkdownBody";
import { Button } from "../../marketing/components/Button";
import { Eyebrow } from "../../marketing/components/Eyebrow";
import {
  StepIndicator,
  WizardCard,
  StepHeading,
  Field,
  ChipRow,
  RadioOption,
  SmallRadioGroup,
  ResultsHeader,
  ReportPanel,
  type StepDef,
} from "./wizard-chrome";
import {
  AUTOMATION_LEVELS,
  BUDGETS,
  EMPLOYEE_RANGES,
  FUNCTION_CATEGORIES,
  GOALS,
  INDUSTRIES,
  REVENUE_RANGES,
  SOFTWARE_SUITES,
  TIMELINES,
  toSlug,
} from "./data";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface FormData {
  companyName: string;
  companyUrl: string;
  industry: string;
  employeeRange: string;
  revenueRange: string;
  description: string;
  currentSystems: string[];
  customSystems: string;
  automationLevel: string;
  aiUsageLevel: string;
  aiGovernance: string;
  agentExperience: string;
  aiOwnership: string;
  challenges: string;
  selectedFunctions: string[];
  primaryGoal: string;
  targets: string;
  timeline: string;
  budgetRange: string;
}

const INITIAL_FORM: FormData = {
  companyName: "",
  companyUrl: "",
  industry: "",
  employeeRange: "",
  revenueRange: "",
  description: "",
  currentSystems: [],
  customSystems: "",
  automationLevel: "",
  aiUsageLevel: "",
  aiGovernance: "",
  agentExperience: "",
  aiOwnership: "",
  challenges: "",
  selectedFunctions: [],
  primaryGoal: "Both",
  targets: "",
  timeline: "",
  budgetRange: "",
};

const STEPS: StepDef[] = [
  { num: 1, label: "Company", icon: Building2 },
  { num: 2, label: "Operations", icon: Settings },
  { num: 3, label: "Functions", icon: Cpu },
  { num: 4, label: "Goals", icon: Target },
];

/* ------------------------------------------------------------------ */
/*  CompanyWizard                                                      */
/* ------------------------------------------------------------------ */

export interface CompanyWizardProps {
  companyId: string;
  defaultCompanyName?: string;
  onSwitchMode?: () => void;
  /**
   * AgentDash (Phase F): callback fired when the deep-interview engine emits
   * the structured `[deep-interview-ready] {…}` marker into the streamed
   * output. The parent (AssessPage on `?onboarding=1`) uses this to call
   * /api/onboarding/finalize-assessment and navigate to /cos.
   *
   * Passes both the parsed stateId and the raw envelope JSON so the parent
   * can log/telemeter as needed.
   */
  onReadyToFinalize?: (info: { stateId: string; round: number; ambiguity: number }) => void;
}

export function CompanyWizard({ companyId, defaultCompanyName, onSwitchMode, onReadyToFinalize }: CompanyWizardProps) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState("");
  const [showResults, setShowResults] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Hydrate the form with the active company's name on mount
  useEffect(() => {
    if (defaultCompanyName && !form.companyName) {
      setForm((prev) => ({ ...prev, companyName: defaultCompanyName }));
    }
  }, [defaultCompanyName, form.companyName]);

  // AgentDash (Phase F): scan streamed output for the deep-interview ready
  // marker. Format: `[deep-interview-ready] {"stateId":"…","round":N,"ambiguity":0.x}`
  // Fires the callback exactly once per page lifetime (firedRef guards repeats
  // when output continues mutating after the marker lands).
  const firedReadyRef = useRef(false);
  useEffect(() => {
    if (firedReadyRef.current || !onReadyToFinalize) return;
    const match = output.match(
      /\[deep-interview-ready\]\s*(\{[^\n}]*"stateId"[^\n}]*\})/,
    );
    if (!match) return;
    try {
      const env = JSON.parse(match[1]!) as {
        stateId?: unknown;
        round?: unknown;
        ambiguity?: unknown;
      };
      if (typeof env.stateId !== "string" || env.stateId.length === 0) return;
      firedReadyRef.current = true;
      onReadyToFinalize({
        stateId: env.stateId,
        round: typeof env.round === "number" ? env.round : 0,
        ambiguity: typeof env.ambiguity === "number" ? env.ambiguity : 1,
      });
    } catch {
      // Malformed envelope — ignore. Engine should always emit valid JSON.
    }
  }, [output, onReadyToFinalize]);

  // Load any prior assessment for this company so the user lands on the report
  // instead of a blank wizard if one already exists.
  const storedQuery = useQuery<StoredAssessment | null>({
    queryKey: ["assess", "stored", companyId],
    queryFn: async () => {
      try {
        return await assessApi.getAssessment(companyId);
      } catch {
        return null;
      }
    },
    enabled: Boolean(companyId),
    staleTime: 60_000,
  });

  const update = <K extends keyof FormData>(key: K, val: FormData[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const toggleFunction = (fnKey: string) => {
    setForm((prev) => ({
      ...prev,
      selectedFunctions: prev.selectedFunctions.includes(fnKey)
        ? prev.selectedFunctions.filter((f) => f !== fnKey)
        : [...prev.selectedFunctions, fnKey],
    }));
  };

  const toggleSystem = (tool: string) => {
    setForm((prev) => ({
      ...prev,
      currentSystems: prev.currentSystems.includes(tool)
        ? prev.currentSystems.filter((t) => t !== tool)
        : [...prev.currentSystems, tool],
    }));
  };

  const canNext = (): boolean => {
    if (step === 1) return Boolean(form.companyName && form.industry && form.companyUrl);
    if (step === 2) return Boolean(form.automationLevel);
    return true;
  };

  const runAssessment = useCallback(async () => {
    if (!companyId) return;
    setOutput("");
    setError("");
    setIsStreaming(true);
    setShowResults(true);
    abortRef.current = new AbortController();

    try {
      const stream = await assessApi.runAssessment(companyId, {
        ...form,
        industrySlug: toSlug(form.industry),
        currentSystems: [...form.currentSystems, form.customSystems].filter(Boolean).join(", "),
        companyUrl: form.companyUrl || undefined,
      }, abortRef.current.signal);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setOutput((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // user cancelled
      } else {
        setError(err instanceof Error ? err.message : "Network error");
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [form, companyId]);

  const handleReset = () => {
    setForm({ ...INITIAL_FORM, companyName: defaultCompanyName ?? "" });
    setOutput("");
    setError("");
    setStep(1);
    setShowResults(false);
  };

  const showStored = !showResults && Boolean(storedQuery.data?.markdown);

  return (
    <>
      {showStored && (
        <div style={{ marginTop: 32 }}>
          <StoredReportCard
            stored={storedQuery.data!}
            companyName={defaultCompanyName ?? form.companyName}
            onRunNew={() => {
              setShowResults(false);
              setOutput("");
              setStep(1);
            }}
            onSwitchMode={onSwitchMode}
          />
        </div>
      )}

      {!showResults && !showStored && (
        <div style={{ marginTop: 48 }}>
          {onSwitchMode && (
            <div style={{ marginBottom: 16, textAlign: "right" }}>
              <Button variant="link" onClick={onSwitchMode}>
                <ChevronLeft size={14} strokeWidth={1.75} aria-hidden /> Back to mode select
              </Button>
            </div>
          )}
          <StepIndicator step={step} steps={STEPS} onJump={(n) => n < step && setStep(n)} />
          <WizardCard>
            {step === 1 && <Step1 form={form} update={update} />}
            {step === 2 && <Step2 form={form} update={update} toggleSystem={toggleSystem} />}
            {step === 3 && <Step3 form={form} toggleFunction={toggleFunction} />}
            {step === 4 && <Step4 form={form} update={update} />}

            <div className="mkt-assess__nav">
              {step > 1 ? (
                <Button variant="link" onClick={() => setStep(step - 1)}>
                  <ChevronLeft size={14} strokeWidth={1.75} aria-hidden /> Back
                </Button>
              ) : <span />}
              {step < 4 ? (
                <Button onClick={() => setStep(step + 1)} disabled={!canNext()}>
                  Next <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
                </Button>
              ) : (
                <Button onClick={runAssessment} disabled={!canNext()}>
                  <Sparkles size={14} strokeWidth={1.75} aria-hidden /> Generate assessment
                </Button>
              )}
            </div>
          </WizardCard>
        </div>
      )}

      {showResults && (
        <div style={{ marginTop: 32 }}>
          <ResultsHeader
            eyebrow="Generating"
            title={`Agent Readiness Report — ${form.companyName}`}
            isStreaming={isStreaming}
            onReset={handleReset}
            onCancel={() => abortRef.current?.abort()}
            badges={[
              form.industry,
              form.employeeRange ? `${form.employeeRange} employees` : "",
              form.primaryGoal,
              form.selectedFunctions.length > 0
                ? `${form.selectedFunctions.length} functions selected`
                : "",
            ].filter(Boolean)}
          />
          <ReportPanel
            error={error}
            output={output}
            isStreaming={isStreaming}
            reportLabel={`Live report — ${form.companyName}`}
          />
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 1: Company                                                    */
/* ------------------------------------------------------------------ */

function Step1({ form, update }: {
  form: FormData;
  update: <K extends keyof FormData>(k: K, v: FormData[K]) => void;
}) {
  return (
    <div>
      <StepHeading title="Company profile" sub="Tell us about the company we're assessing." />
      <div className="mkt-assess__grid-2">
        <Field label="Company name *" value={form.companyName} onChange={(v) => update("companyName", v)} placeholder="e.g. AgentDash" />
        <Field label="Company website or LinkedIn *" value={form.companyUrl} onChange={(v) => update("companyUrl", v)} placeholder="https://www.example.com" />

        <div>
          <label className="mkt-assess__label">Industry *</label>
          <select
            className="mkt-assess__select"
            value={form.industry}
            onChange={(e) => update("industry", e.target.value)}
          >
            <option value="">Select industry...</option>
            {INDUSTRIES.map((ind) => <option key={ind} value={ind}>{ind}</option>)}
          </select>
        </div>

        <div>
          <label className="mkt-assess__label">Employee count</label>
          <ChipRow
            options={EMPLOYEE_RANGES}
            value={form.employeeRange}
            onSelect={(v) => update("employeeRange", v)}
          />
        </div>

        <div>
          <label className="mkt-assess__label">Annual revenue</label>
          <ChipRow
            options={REVENUE_RANGES}
            value={form.revenueRange}
            onSelect={(v) => update("revenueRange", v)}
          />
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <Field
          label="Company description"
          value={form.description}
          onChange={(v) => update("description", v)}
          placeholder="What does the company do? Products, services, market position…"
          multiline
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 2: Operations                                                 */
/* ------------------------------------------------------------------ */

function Step2({ form, update, toggleSystem }: {
  form: FormData;
  update: <K extends keyof FormData>(k: K, v: FormData[K]) => void;
  toggleSystem: (tool: string) => void;
}) {
  return (
    <div>
      <StepHeading title="Current operations" sub="What's their tech stack, and where does work get stuck?" />

      <div style={{ display: "grid", gap: 24 }}>
        <div>
          <label className="mkt-assess__label">
            Key systems &amp; tools
            {form.currentSystems.length > 0 && (
              <span className="mkt-assess__count"> · {form.currentSystems.length} selected</span>
            )}
          </label>
          <div style={{ display: "grid", gap: 16 }}>
            {SOFTWARE_SUITES.map((group) => (
              <div key={group.category}>
                <div className="mkt-assess__group-tag">{group.category}</div>
                <div className="mkt-assess__chips">
                  {group.tools.map((tool) => {
                    const selected = form.currentSystems.includes(tool);
                    return (
                      <button
                        key={tool}
                        type="button"
                        onClick={() => toggleSystem(tool)}
                        className={`mkt-assess__chip ${selected ? "mkt-assess__chip--selected" : ""}`}
                      >{tool}</button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <input
              className="mkt-assess__input"
              value={form.customSystems}
              onChange={(e) => update("customSystems", e.target.value)}
              placeholder="Other systems not listed (comma-separated)"
            />
          </div>
        </div>

        <div>
          <label className="mkt-assess__label">Current automation level *</label>
          <div style={{ display: "grid", gap: 8 }}>
            {AUTOMATION_LEVELS.map((al) => (
              <RadioOption
                key={al.value}
                selected={form.automationLevel === al.value}
                onClick={() => update("automationLevel", al.value)}
                title={al.label}
                desc={al.desc}
              />
            ))}
          </div>
        </div>

        <Field
          label="Biggest operational challenges"
          value={form.challenges}
          onChange={(v) => update("challenges", v)}
          placeholder="What keeps them up at night? Where do they waste the most time/money?"
          multiline
        />

        <div className="mkt-assess__divider">
          <Eyebrow>AI maturity snapshot</Eyebrow>
          <span className="mkt-assess__hint">Helps detect readiness gaps</span>
        </div>

        <div className="mkt-assess__grid-2">
          <SmallRadioGroup
            label="Current AI usage"
            options={[
              { value: "none", label: "No AI tools in use" },
              { value: "individual", label: "Individual use (ChatGPT, Copilot)" },
              { value: "embedded", label: "AI embedded in some workflows" },
              { value: "agents", label: "Running autonomous AI agents" },
            ]}
            value={form.aiUsageLevel}
            onSelect={(v) => update("aiUsageLevel", v)}
          />
          <SmallRadioGroup
            label="AI governance"
            options={[
              { value: "none", label: "No AI policy" },
              { value: "informal", label: "Informal guidelines" },
              { value: "formal", label: "Formal AI governance policy" },
              { value: "regulated", label: "Regulated (HIPAA, FedRAMP, etc.)" },
            ]}
            value={form.aiGovernance}
            onSelect={(v) => update("aiGovernance", v)}
          />
          <SmallRadioGroup
            label="Agent experience"
            options={[
              { value: "none", label: "Never deployed an AI agent" },
              { value: "experimented", label: "Experimented / POC stage" },
              { value: "production", label: "Agents in production" },
            ]}
            value={form.agentExperience}
            onSelect={(v) => update("agentExperience", v)}
          />
          <SmallRadioGroup
            label="Who would own AI agents?"
            options={[
              { value: "nobody", label: "No one identified yet" },
              { value: "it", label: "IT / Engineering team" },
              { value: "business", label: "Business unit leads" },
              { value: "dedicated", label: "Dedicated AI / Innovation team" },
            ]}
            value={form.aiOwnership}
            onSelect={(v) => update("aiOwnership", v)}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 3: Functions                                                  */
/* ------------------------------------------------------------------ */

function Step3({ form, toggleFunction }: {
  form: FormData;
  toggleFunction: (key: string) => void;
}) {
  return (
    <div>
      <StepHeading
        title="Functions to analyze"
        sub="Pick which business functions to focus on. Leave empty for a broad scan of all 21."
      />
      <div className="mkt-assess__grid-3">
        {FUNCTION_CATEGORIES.map((cat) => (
          <div key={cat.key} className="mkt-assess__fn-group">
            <div className="mkt-assess__fn-group-tag">{cat.name}</div>
            <div style={{ display: "grid", gap: 4 }}>
              {cat.subs.map((sub) => {
                const selected = form.selectedFunctions.includes(sub.key);
                return (
                  <button
                    key={sub.key}
                    type="button"
                    onClick={() => toggleFunction(sub.key)}
                    className={`mkt-assess__fn-row ${selected ? "mkt-assess__fn-row--selected" : ""}`}
                  >
                    <span className={`mkt-assess__fn-check ${selected ? "mkt-assess__fn-check--selected" : ""}`}>
                      {selected && <CheckCircle2 size={10} strokeWidth={2} />}
                    </span>
                    {sub.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {form.selectedFunctions.length > 0 && (
        <div className="mkt-assess__count-line">
          {form.selectedFunctions.length} function{form.selectedFunctions.length === 1 ? "" : "s"} selected
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 4: Goals                                                      */
/* ------------------------------------------------------------------ */

function Step4({ form, update }: {
  form: FormData;
  update: <K extends keyof FormData>(k: K, v: FormData[K]) => void;
}) {
  return (
    <div>
      <StepHeading title="Agentification goals" sub="What does the company want to achieve?" />

      <div style={{ display: "grid", gap: 24 }}>
        <div>
          <label className="mkt-assess__label">Primary goal</label>
          <ChipRow options={GOALS} value={form.primaryGoal} onSelect={(v) => update("primaryGoal", v)} />
        </div>

        <Field
          label="Specific targets"
          value={form.targets}
          onChange={(v) => update("targets", v)}
          placeholder="e.g. Reduce support costs by 30%, accelerate proposal turnaround by 50%…"
          multiline
        />

        <div>
          <label className="mkt-assess__label">Timeline</label>
          <ChipRow options={TIMELINES} value={form.timeline} onSelect={(v) => update("timeline", v)} />
        </div>

        <div>
          <label className="mkt-assess__label">Pilot budget range</label>
          <ChipRow options={BUDGETS} value={form.budgetRange} onSelect={(v) => update("budgetRange", v)} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  StoredReportCard                                                   */
/* ------------------------------------------------------------------ */

function StoredReportCard({ stored, companyName, onRunNew, onSwitchMode }: {
  stored: StoredAssessment;
  companyName: string;
  onRunNew: () => void;
  onSwitchMode?: () => void;
}) {
  return (
    <div className="mkt-assess__card">
      <div className="mkt-assess__results-head">
        <div>
          <Eyebrow>Most recent assessment</Eyebrow>
          <h2 className="mkt-display-section" style={{ fontSize: 32, marginTop: 8 }}>
            Agent Readiness Report — {companyName}
          </h2>
        </div>
        <div className="mkt-assess__results-actions">
          {onSwitchMode && (
            <Button variant="ghost" onClick={onSwitchMode}>
              <ChevronLeft size={14} strokeWidth={1.75} aria-hidden /> Switch mode
            </Button>
          )}
          <Button variant="ghost" onClick={onRunNew}>
            <RotateCcw size={14} strokeWidth={1.75} aria-hidden /> Run new assessment
          </Button>
        </div>
      </div>
      <div className="mkt-assess__report">
        <MarkdownBody>{stored.markdown}</MarkdownBody>
      </div>
      {stored.jumpstart && (
        <details className="mkt-assess__jumpstart">
          <summary>Jumpstart document</summary>
          <div className="mkt-assess__report" style={{ marginTop: 16 }}>
            <MarkdownBody>{stored.jumpstart}</MarkdownBody>
          </div>
        </details>
      )}
    </div>
  );
}
