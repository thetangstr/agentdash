// AgentDash: Agent Readiness Assessment — 4-step wizard ported from
// agent-factory-research, restyled to inherit the marketing surface
// (cream + coral, Newsreader serif, Inter Tight body).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Loader2,
  RotateCcw,
  Settings,
  Sparkles,
  Target,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useQuery } from "@tanstack/react-query";
import { assessApi, type StoredAssessment } from "../api/assess";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarketingShell } from "../marketing/MarketingShell";
import { SectionContainer } from "../marketing/components/SectionContainer";
import { Eyebrow } from "../marketing/components/Eyebrow";
import { Button } from "../marketing/components/Button";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const INDUSTRIES = [
  "Public Sector", "E-Commerce", "Insurance", "Healthcare", "Logistics",
  "Financial Services", "Manufacturing", "Real Estate", "Legal", "Education",
  "Tech/SaaS", "Retail", "Energy/Utilities", "Telecom",
  "Media/Entertainment", "Construction", "Hospitality", "Agriculture",
];

function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const EMPLOYEE_RANGES = ["1-50", "51-200", "201-1,000", "1,001-5,000", "5,000+"];
const REVENUE_RANGES = ["< $5M", "$5–25M", "$25–100M", "$100M–1B", "> $1B"];
const AUTOMATION_LEVELS = [
  { value: "manual", label: "Mostly manual", desc: "Spreadsheets, email, phone" },
  { value: "basic", label: "Basic automation", desc: "Some RPA, simple scripts, Zapier" },
  { value: "advanced", label: "Advanced but hitting ceiling", desc: "Mature RPA/rules but breaks on edge cases" },
];
const GOALS = ["Revenue growth", "Cost reduction", "Both"];
const TIMELINES = ["Immediate need", "3-6 months", "Just exploring"];
const BUDGETS = ["< $50K", "$50–150K", "$150–500K", "> $500K", "Not sure yet"];

const FUNCTION_CATEGORIES = [
  {
    key: "sales", name: "Sales", subs: [
      { key: "business-development", name: "Business Development" },
      { key: "account-management", name: "Account Management" },
      { key: "revenue-operations", name: "Revenue Operations" },
    ],
  },
  {
    key: "customer-support", name: "Customer Support", subs: [
      { key: "contact-center", name: "Contact Center" },
      { key: "field-service", name: "Field Service" },
      { key: "customer-success", name: "Success & Retention" },
    ],
  },
  {
    key: "hr", name: "HR", subs: [
      { key: "talent-acquisition", name: "Talent Acquisition" },
      { key: "workforce-management", name: "Workforce Management" },
      { key: "hr-compliance", name: "Compliance & Benefits" },
    ],
  },
  {
    key: "finance", name: "Finance", subs: [
      { key: "accounting-arap", name: "Accounting & AR/AP" },
      { key: "fpa-reporting", name: "FP&A & Reporting" },
      { key: "risk-compliance", name: "Risk & Compliance" },
      { key: "procurement", name: "Procurement" },
    ],
  },
  {
    key: "it-engineering", name: "IT / Engineering", subs: [
      { key: "cybersecurity", name: "Cybersecurity / SOC" },
      { key: "devops-sre", name: "DevOps / SRE" },
      { key: "data-engineering", name: "Data Engineering" },
      { key: "software-dev", name: "Software Development" },
    ],
  },
  {
    key: "operations", name: "Operations", subs: [
      { key: "supply-chain", name: "Supply Chain" },
      { key: "facilities", name: "Facilities & Maintenance" },
      { key: "quality-regulatory", name: "Quality / Regulatory" },
      { key: "program-management", name: "Program Management" },
    ],
  },
];

const SOFTWARE_SUITES = [
  { category: "CRM & Sales", tools: ["Salesforce", "HubSpot", "Dynamics 365", "Pipedrive", "Zoho CRM"] },
  { category: "ERP", tools: ["SAP", "Oracle", "NetSuite", "Sage", "Odoo"] },
  { category: "IT & Support", tools: ["ServiceNow", "Jira", "Zendesk", "Freshdesk", "PagerDuty"] },
  { category: "Healthcare", tools: ["Epic", "Cerner", "Athenahealth", "MEDITECH"] },
  { category: "Cloud & Infra", tools: ["AWS", "Azure", "GCP", "IBM Cloud"] },
  { category: "Collaboration", tools: ["Slack", "Microsoft Teams", "Google Workspace", "Zoom"] },
  { category: "Finance & HR", tools: ["Workday", "QuickBooks", "Xero", "ADP", "BambooHR", "Gusto"] },
  { category: "Engineering", tools: ["GitHub", "GitLab", "Jenkins", "Datadog", "Splunk"] },
  { category: "Project & Ops", tools: ["Asana", "Monday.com", "Smartsheet", "Procore", "Airtable"] },
  { category: "Data & Analytics", tools: ["Snowflake", "Databricks", "Tableau", "Power BI", "Looker"] },
];

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

const STEPS = [
  { num: 1, label: "Company", icon: Building2 },
  { num: 2, label: "Operations", icon: Settings },
  { num: 3, label: "Functions", icon: Cpu },
  { num: 4, label: "Goals", icon: Target },
];

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export function AssessPage() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;

  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState("");
  const [showResults, setShowResults] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Hydrate the form with the active company's name on mount
  useEffect(() => {
    if (selectedCompany?.name && !form.companyName) {
      setForm((prev) => ({ ...prev, companyName: selectedCompany.name }));
    }
  }, [selectedCompany?.name, form.companyName]);

  // Load any prior assessment for this company so the user lands on the report
  // instead of a blank wizard if one already exists.
  const storedQuery = useQuery<StoredAssessment | null>({
    queryKey: ["assess", "stored", companyId],
    queryFn: async () => {
      if (!companyId) return null;
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
    setForm({ ...INITIAL_FORM, companyName: selectedCompany?.name ?? "" });
    setOutput("");
    setError("");
    setStep(1);
    setShowResults(false);
  };

  const showStored = !showResults && Boolean(storedQuery.data?.markdown);

  /* ---------------------------------------------------------------- */
  /*  No-company guard                                                  */
  /* ---------------------------------------------------------------- */
  if (!companyId) {
    return (
      <MarketingShell>
        <SectionContainer>
          <Eyebrow>Agent Readiness Assessment</Eyebrow>
          <h1 className="mkt-display-page" style={{ marginTop: 16, marginBottom: 16 }}>
            Select a company first.
          </h1>
          <p className="mkt-body-lg" style={{ color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
            The assessment is scoped to a company. Pick or create one from the company switcher,
            then come back to run a readiness analysis.
          </p>
        </SectionContainer>
      </MarketingShell>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                            */
  /* ---------------------------------------------------------------- */
  return (
    <MarketingShell>
      <SectionContainer>
        <Eyebrow>Agent Readiness Assessment</Eyebrow>
        <h1 className="mkt-display-page" style={{ marginTop: 16, marginBottom: 16, maxWidth: "20ch" }}>
          Where does {selectedCompany?.name ?? "your company"} sit on the readiness curve?
        </h1>
        <p className="mkt-body-lg" style={{ color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
          Four short steps. Our research data — 378 industry × function cells, deep playbooks, and
          market reports — powers a tailored agent deployment proposal.
        </p>

        {showStored && (
          <div style={{ marginTop: 32 }}>
            <StoredReportCard
              stored={storedQuery.data!}
              companyName={selectedCompany?.name ?? form.companyName}
              onRunNew={() => {
                setShowResults(false);
                setOutput("");
                setStep(1);
              }}
            />
          </div>
        )}

        {!showResults && !showStored && (
          <div style={{ marginTop: 48 }}>
            <StepIndicator step={step} onJump={(n) => n < step && setStep(n)} />
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
              companyName={form.companyName}
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
              companyName={form.companyName}
            />
          </div>
        )}
      </SectionContainer>

      <AssessLocalStyles />
    </MarketingShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Step indicator + wizard chrome                                     */
/* ------------------------------------------------------------------ */

function StepIndicator({ step, onJump }: { step: number; onJump: (n: number) => void }) {
  return (
    <div className="mkt-assess__steps">
      {STEPS.map((s) => {
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

function WizardCard({ children }: { children: React.ReactNode }) {
  return <div className="mkt-assess__card">{children}</div>;
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
/*  Reusable bits                                                      */
/* ------------------------------------------------------------------ */

function StepHeading({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 className="mkt-display-section" style={{ fontSize: 32, marginBottom: 8 }}>{title}</h2>
      <p className="mkt-caption" style={{ fontSize: 15 }}>{sub}</p>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  multiline?: boolean;
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
      {multiline ? <textarea {...common} rows={3} /> : <input {...common} />}
    </div>
  );
}

function ChipRow({ options, value, onSelect }: {
  options: string[]; value: string; onSelect: (v: string) => void;
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

function RadioOption({ selected, onClick, title, desc }: {
  selected: boolean; onClick: () => void; title: string; desc: string;
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

function SmallRadioGroup({ label, options, value, onSelect }: {
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
/*  Stored report card (shown when company has a prior assessment)     */
/* ------------------------------------------------------------------ */

function StoredReportCard({ stored, companyName, onRunNew }: {
  stored: StoredAssessment;
  companyName: string;
  onRunNew: () => void;
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
        <Button variant="ghost" onClick={onRunNew}>
          <RotateCcw size={14} strokeWidth={1.75} aria-hidden /> Run new assessment
        </Button>
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

/* ------------------------------------------------------------------ */
/*  Results header + report panel (live streaming)                     */
/* ------------------------------------------------------------------ */

function ResultsHeader({
  companyName, isStreaming, badges, onReset, onCancel,
}: {
  companyName: string;
  isStreaming: boolean;
  badges: string[];
  onReset: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mkt-assess__results-head">
      <div>
        <Eyebrow>Generating</Eyebrow>
        <h2 className="mkt-display-section" style={{ fontSize: 32, marginTop: 8 }}>
          Agent Readiness Report — {companyName}
        </h2>
        <div className="mkt-assess__badges">
          {badges.map((b) => <span key={b} className="mkt-assess__badge">{b}</span>)}
        </div>
      </div>
      <div className="mkt-assess__results-actions">
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

function ReportPanel({ output, error, isStreaming, companyName }: {
  output: string;
  error: string;
  isStreaming: boolean;
  companyName: string;
}) {
  return (
    <div className="mkt-assess__card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="mkt-assess__report-head">
        <Sparkles size={14} strokeWidth={1.75} aria-hidden style={{ color: "var(--mkt-accent)" }} />
        <span>Live report — {companyName}</span>
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
            <span>Retrieving research data and generating the assessment…</span>
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
/*  Page-local styles                                                  */
/*  (kept inline so the new wizard stays portable as a single file —    */
/*   the marketing surface is the source of truth for tokens)           */
/* ------------------------------------------------------------------ */

function AssessLocalStyles() {
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
    `}</style>
  );
}
