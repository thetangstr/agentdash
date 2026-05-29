// AgentDash: CompanyWizard - compact company-level intake for the initial
// assessment path. Project-scoped assessment remains separate in ProjectWizard.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { assessApi, type StoredAssessment } from "../../api/assess";
import { MarkdownBody } from "../../components/MarkdownBody";
import { Button } from "../../marketing/components/Button";
import { Eyebrow } from "../../marketing/components/Eyebrow";
import {
  RadioOption,
  ResultsHeader,
  ReportPanel,
  WizardCard,
} from "./wizard-chrome";
import {
  FUNCTION_CATEGORIES,
  INDUSTRIES,
  toSlug,
} from "./data";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type AiMaturity = "none" | "individual" | "workflow" | "agents" | "";

interface FormData {
  companyName: string;
  companyUrl: string;
  industry: string;
  description: string;
  challenges: string;
  currentSystems: string;
  aiMaturity: AiMaturity;
  selectedFunctions: string[];
  targets: string;
}

const INITIAL_FORM: FormData = {
  companyName: "",
  companyUrl: "",
  industry: "",
  description: "",
  challenges: "",
  currentSystems: "",
  aiMaturity: "",
  selectedFunctions: [],
  targets: "",
};

const AI_MATURITY_OPTIONS: Array<{
  value: Exclude<AiMaturity, "">;
  title: string;
  desc: string;
  payload: {
    aiUsageLevel: string;
    aiGovernance: string;
    agentExperience: string;
    aiOwnership: string;
    automationLevel: string;
  };
}> = [
  {
    value: "none",
    title: "No AI use yet",
    desc: "The company is still deciding where AI belongs.",
    payload: {
      aiUsageLevel: "none",
      aiGovernance: "none",
      agentExperience: "none",
      aiOwnership: "nobody",
      automationLevel: "manual",
    },
  },
  {
    value: "individual",
    title: "Individual AI tools",
    desc: "People use ChatGPT, Copilot, or similar tools on their own.",
    payload: {
      aiUsageLevel: "individual",
      aiGovernance: "informal",
      agentExperience: "none",
      aiOwnership: "nobody",
      automationLevel: "basic",
    },
  },
  {
    value: "workflow",
    title: "AI in business workflows",
    desc: "Some teams use AI in repeated processes, but ownership is uneven.",
    payload: {
      aiUsageLevel: "embedded",
      aiGovernance: "informal",
      agentExperience: "experimented",
      aiOwnership: "business",
      automationLevel: "advanced",
    },
  },
  {
    value: "agents",
    title: "Agents already running",
    desc: "The company has one or more agent-like systems in production.",
    payload: {
      aiUsageLevel: "agents",
      aiGovernance: "formal",
      agentExperience: "production",
      aiOwnership: "dedicated",
      automationLevel: "advanced",
    },
  },
];

/* ------------------------------------------------------------------ */
/*  CompanyWizard                                                      */
/* ------------------------------------------------------------------ */

export interface CompanyWizardProps {
  companyId: string;
  defaultCompanyName?: string;
  onSwitchMode?: () => void;
  onInitialAssessmentComplete?: (info: {
    assessmentMarkdown: string;
    assessmentInput: Record<string, unknown>;
  }) => void | Promise<void>;
  /**
   * AgentDash (Phase F): callback fired when the deep-interview engine emits
   * the structured `[deep-interview-ready] {..}` marker into the streamed
   * output. The parent (AssessPage on `?onboarding=1`) uses this to call
   * /api/onboarding/finalize-assessment and navigate to /cos.
   */
  onReadyToFinalize?: (info: { stateId: string; round: number; ambiguity: number }) => void;
}

export function CompanyWizard({
  companyId,
  defaultCompanyName,
  onSwitchMode,
  onInitialAssessmentComplete,
  onReadyToFinalize,
}: CompanyWizardProps) {
  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState("");
  const [showResults, setShowResults] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (defaultCompanyName && !form.companyName) {
      setForm((prev) => ({ ...prev, companyName: defaultCompanyName }));
    }
  }, [defaultCompanyName, form.companyName]);

  // AgentDash (Phase F): scan streamed output for the deep-interview ready
  // marker. Format: `[deep-interview-ready] {"stateId":"..","round":N,"ambiguity":0.x}`
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
      // Malformed envelope - ignore. Engine should always emit valid JSON.
    }
  }, [output, onReadyToFinalize]);

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

  const selectedMaturity = AI_MATURITY_OPTIONS.find((option) => option.value === form.aiMaturity);

  const canSubmit = Boolean(
    form.companyName.trim() &&
      form.industry &&
      form.description.trim() &&
      form.challenges.trim() &&
      form.aiMaturity &&
      form.targets.trim(),
  );

  const buildAssessmentPayload = useCallback((): Record<string, unknown> => {
    const maturityPayload = selectedMaturity?.payload ?? AI_MATURITY_OPTIONS[0]!.payload;

    return {
      assessmentKind: "initial_company",
      companyName: form.companyName.trim(),
      companyUrl: form.companyUrl.trim() || undefined,
      industry: form.industry,
      industrySlug: toSlug(form.industry),
      employeeRange: "",
      revenueRange: "",
      description: form.description.trim(),
      currentSystems: form.currentSystems.trim(),
      challenges: form.challenges.trim(),
      selectedFunctions: form.selectedFunctions,
      primaryGoal: "Both",
      targets: form.targets.trim(),
      timeline: "Immediate need",
      budgetRange: "Not sure yet",
      ...maturityPayload,
    };
  }, [form, selectedMaturity]);

  const runAssessment = useCallback(async () => {
    if (!companyId || !canSubmit) return;
    setOutput("");
    setError("");
    setIsStreaming(true);
    setShowResults(true);
    abortRef.current = new AbortController();

    try {
      const stream = await assessApi.runAssessment(
        companyId,
        buildAssessmentPayload(),
        abortRef.current.signal,
      );

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setOutput((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // User cancelled.
      } else {
        setError(err instanceof Error ? err.message : "Network error");
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [buildAssessmentPayload, canSubmit, companyId]);

  const handleReset = () => {
    setForm({ ...INITIAL_FORM, companyName: defaultCompanyName ?? "" });
    setOutput("");
    setError("");
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
          <WizardCard>
            <div style={{ display: "grid", gap: 28 }}>
              <QuestionBlock
                num={1}
                title="What company are we assessing?"
                sub="Give enough context for a company-level recommendation."
              >
                <div className="mkt-assess__grid-2">
                  <div>
                    <label className="mkt-assess__label" htmlFor="company-name">Company name *</label>
                    <input
                      id="company-name"
                      className="mkt-assess__input"
                      value={form.companyName}
                      onChange={(event) => update("companyName", event.target.value)}
                      placeholder="Acme Corp"
                      autoComplete="organization"
                    />
                  </div>
                  <div>
                    <label className="mkt-assess__label" htmlFor="company-url">Website or LinkedIn</label>
                    <input
                      id="company-url"
                      className="mkt-assess__input"
                      value={form.companyUrl}
                      onChange={(event) => update("companyUrl", event.target.value)}
                      placeholder="https://www.example.com"
                      autoComplete="url"
                    />
                  </div>
                  <div>
                    <label className="mkt-assess__label" htmlFor="company-industry">Industry *</label>
                    <select
                      id="company-industry"
                      className="mkt-assess__select"
                      value={form.industry}
                      onChange={(event) => update("industry", event.target.value)}
                    >
                      <option value="">Select industry...</option>
                      {INDUSTRIES.map((industry) => (
                        <option key={industry} value={industry}>{industry}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div style={{ marginTop: 14 }}>
                  <label className="mkt-assess__label" htmlFor="company-description">What does the company do? *</label>
                  <textarea
                    id="company-description"
                    className="mkt-assess__input"
                    value={form.description}
                    onChange={(event) => update("description", event.target.value)}
                    placeholder="Products, customers, business model, market position..."
                  />
                </div>
              </QuestionBlock>

              <QuestionBlock
                num={2}
                title="What business outcome is blocked today?"
                sub="Name the actual cost, delay, risk, or missed revenue - not just the IT symptom."
              >
                <textarea
                  id="business-outcome"
                  className="mkt-assess__input"
                  value={form.challenges}
                  onChange={(event) => update("challenges", event.target.value)}
                  placeholder="Example: Sales loses two days per proposal because approved technical answers are hard to find."
                />
              </QuestionBlock>

              <QuestionBlock
                num={3}
                title="Which systems does that work depend on?"
                sub="List the systems agents would need to read from or write to."
              >
                <input
                  id="current-systems"
                  className="mkt-assess__input"
                  value={form.currentSystems}
                  onChange={(event) => update("currentSystems", event.target.value)}
                  placeholder="Salesforce, SharePoint, Zendesk, NetSuite, Slack..."
                />
              </QuestionBlock>

              <QuestionBlock
                num={4}
                title="How mature is AI adoption right now?"
                sub="Pick the closest description."
              >
                <div style={{ display: "grid", gap: 8 }}>
                  {AI_MATURITY_OPTIONS.map((option) => (
                    <RadioOption
                      key={option.value}
                      selected={form.aiMaturity === option.value}
                      onClick={() => update("aiMaturity", option.value)}
                      title={option.title}
                      desc={option.desc}
                    />
                  ))}
                </div>
              </QuestionBlock>

              <QuestionBlock
                num={5}
                title="Where should AI agents start first?"
                sub="Pick one or two business areas, then name the outcome to improve."
              >
                <div className="mkt-assess__chips" style={{ marginBottom: 12 }}>
                  {FUNCTION_CATEGORIES.map((category) => {
                    const selected = form.selectedFunctions.includes(category.key);
                    return (
                      <button
                        key={category.key}
                        type="button"
                        onClick={() => toggleFunction(category.key)}
                        className={`mkt-assess__chip ${selected ? "mkt-assess__chip--selected" : ""}`}
                      >
                        {selected && <CheckCircle2 size={12} strokeWidth={2} aria-hidden />}
                        {category.name}
                      </button>
                    );
                  })}
                </div>
                <textarea
                  id="first-ai-target"
                  className="mkt-assess__input"
                  value={form.targets}
                  onChange={(event) => update("targets", event.target.value)}
                  placeholder="Example: Cut proposal response time by 50% without increasing compliance risk."
                />
              </QuestionBlock>
            </div>

            <div className="mkt-assess__nav">
              <span className="mkt-assess__hint">
                Five questions. Company-level only.
              </span>
              <Button onClick={runAssessment} disabled={!canSubmit}>
                <Sparkles size={14} strokeWidth={1.75} aria-hidden /> Generate starting point
              </Button>
            </div>
          </WizardCard>
        </div>
      )}

      {showResults && (
        <div style={{ marginTop: 32 }}>
          <ResultsHeader
            eyebrow="Generating"
            title={`AI Adoption Starting Point - ${form.companyName}`}
            isStreaming={isStreaming}
            onReset={handleReset}
            onCancel={() => abortRef.current?.abort()}
            badges={[
              form.industry,
              selectedMaturity?.title ?? "",
              form.selectedFunctions.length > 0
                ? `${form.selectedFunctions.length} focus area${form.selectedFunctions.length === 1 ? "" : "s"}`
                : "company scan",
            ].filter(Boolean)}
          />
          <ReportPanel
            error={error}
            output={output}
            isStreaming={isStreaming}
            reportLabel={`Starting point - ${form.companyName}`}
          />
          {onInitialAssessmentComplete && output && !isStreaming && !error && (
            <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
              <Button
                onClick={() => {
                  void onInitialAssessmentComplete({
                    assessmentMarkdown: output,
                    assessmentInput: buildAssessmentPayload(),
                  });
                }}
              >
                Continue to Chief of Staff
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function QuestionBlock({
  num,
  title,
  sub,
  children,
}: {
  num: number;
  title: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <section data-assessment-question className="mkt-assess__question-block">
      <div className="mkt-assess__question-meta">Question {num} of 5</div>
      <h2 className="mkt-assess__question-title">{title}</h2>
      <p className="mkt-assess__question-sub">{sub}</p>
      <div style={{ marginTop: 14 }}>{children}</div>
    </section>
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
            AI Adoption Starting Point - {companyName}
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
