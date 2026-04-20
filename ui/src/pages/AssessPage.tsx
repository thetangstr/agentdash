// AgentDash: Assess Page — 6-phase flow (Start → Confirm → Form → DeepDive → Generating → Report)
import { useState, useRef, useEffect, useCallback } from "react";
import { useCompany } from "../context/CompanyContext";
import { assessApi, type ResearchResult, type InterviewResponse } from "../api/assess";
import { MarkdownBody } from "../components/MarkdownBody";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

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

const INDUSTRIES = [
  { label: "Public Sector", slug: "public-sector" },
  { label: "E-Commerce", slug: "e-commerce" },
  { label: "Insurance", slug: "insurance" },
  { label: "Healthcare", slug: "healthcare" },
  { label: "Logistics", slug: "logistics" },
  { label: "Financial Services", slug: "financial-services" },
  { label: "Manufacturing", slug: "manufacturing" },
  { label: "Real Estate", slug: "real-estate" },
  { label: "Legal", slug: "legal" },
  { label: "Education", slug: "education" },
  { label: "Tech/SaaS", slug: "tech-saas" },
  { label: "Retail", slug: "retail" },
  { label: "Energy/Utilities", slug: "energy-utilities" },
  { label: "Telecom", slug: "telecom" },
  { label: "Media/Entertainment", slug: "media-entertainment" },
  { label: "Construction", slug: "construction" },
  { label: "Hospitality", slug: "hospitality" },
  { label: "Agriculture", slug: "agriculture" },
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

const SCOPE_OPTIONS = [
  { v: "entire", l: "The entire organization" },
  { v: "marketing", l: "Marketing & Sales" },
  { v: "operations", l: "Operations & Supply Chain" },
  { v: "it", l: "IT & Engineering" },
  { v: "finance", l: "Finance & Accounting" },
  { v: "support", l: "Customer Support & Service" },
  { v: "hr", l: "HR & People" },
  { v: "custom", l: "A specific department or business unit" },
];

function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Phase = "start" | "confirm" | "form" | "deepdive" | "generating" | "report";

interface FormData {
  companyName: string;
  companyUrl: string;
  industry: string;
  industrySlug: string;
  scope: string;
  employeeRange: string;
  revenueRange: string;
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
  companyName: "", companyUrl: "", industry: "", industrySlug: "", scope: "",
  employeeRange: "", revenueRange: "", currentSystems: [], customSystems: "",
  automationLevel: "", aiUsageLevel: "", aiGovernance: "", agentExperience: "",
  aiOwnership: "", challenges: "", selectedFunctions: [], primaryGoal: "Both",
  targets: "", timeline: "", budgetRange: "",
};

interface ConversationRound {
  question: string;
  options: string[];
  answer: string;
  insights: Array<{ label: string; value: string; icon: string }>;
  clarityScore: number;
  thinkingSummary?: string;
}

/* ------------------------------------------------------------------ */
/*  Small UI helpers                                                   */
/* ------------------------------------------------------------------ */

function Chip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
        selected
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-transparent text-muted-foreground border-border hover:bg-accent"
      }`}
    >
      {label}
    </button>
  );
}

function MaturitySelect({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wide mb-1.5 text-muted-foreground">{label}</label>
      <div className="space-y-1">
        {options.map((o) => {
          const sel = value === o.v;
          return (
            <button
              key={o.v}
              onClick={() => onChange(o.v)}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors flex items-center gap-2 ${
                sel ? "border-2 border-primary bg-accent" : "border border-transparent hover:bg-accent/50"
              }`}
            >
              <span className={`flex-shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                sel ? "border-primary" : "border-muted-foreground"
              }`}>
                {sel && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
              </span>
              <span className="text-foreground">{o.l}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Form sub-steps                                                     */
/* ------------------------------------------------------------------ */

function FormOperations({ form, update, toggleSystem }: {
  form: FormData;
  update: <K extends keyof FormData>(k: K, v: FormData[K]) => void;
  toggleSystem: (t: string) => void;
}) {
  return (
    <div>
      <h2 className="text-base font-semibold mb-1 text-foreground">Current Operations</h2>
      <p className="text-xs mb-4 text-muted-foreground">Tech stack, automation, and AI maturity for {form.companyName}.</p>

      <div className="grid md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-xs font-medium mb-1.5 text-foreground">Employee Count</label>
          <div className="flex flex-wrap gap-1.5">
            {EMPLOYEE_RANGES.map((r) => (
              <Chip key={r} label={r} selected={form.employeeRange === r} onClick={() => update("employeeRange", r)} />
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1.5 text-foreground">Revenue</label>
          <div className="flex flex-wrap gap-1.5">
            {REVENUE_RANGES.map((r) => (
              <Chip key={r} label={r} selected={form.revenueRange === r} onClick={() => update("revenueRange", r)} />
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium mb-2 text-foreground">
            Key Systems {form.currentSystems.length > 0 && <span className="text-primary">({form.currentSystems.length})</span>}
          </label>
          <div className="space-y-3">
            {SOFTWARE_SUITES.map((g) => (
              <div key={g.category}>
                <div className="text-[10px] font-bold uppercase tracking-wide mb-1.5 text-muted-foreground">{g.category}</div>
                <div className="flex flex-wrap gap-1.5">
                  {g.tools.map((t) => (
                    <Chip key={t} label={t} selected={form.currentSystems.includes(t)} onClick={() => toggleSystem(t)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <input
            value={form.customSystems}
            onChange={(e) => update("customSystems", e.target.value)}
            placeholder="Other systems (comma-separated)"
            className="w-full px-3 py-2 rounded-lg text-xs mt-3 focus:outline-none border border-border bg-card text-foreground"
          />
        </div>

        <div>
          <label className="block text-xs font-medium mb-2 text-foreground">Automation Level *</label>
          <div className="space-y-2">
            {AUTOMATION_LEVELS.map((al) => {
              const sel = form.automationLevel === al.value;
              return (
                <button
                  key={al.value}
                  onClick={() => update("automationLevel", al.value)}
                  className={`w-full text-left px-4 py-3 rounded-lg transition-colors flex items-start gap-3 ${
                    sel ? "border-2 border-primary bg-accent" : "border border-transparent hover:bg-accent/50"
                  }`}
                >
                  <span className={`flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center mt-0.5 ${
                    sel ? "border-primary" : "border-muted-foreground"
                  }`}>
                    {sel && <span className="w-2 h-2 rounded-full bg-primary" />}
                  </span>
                  <div>
                    <div className="text-sm font-medium text-foreground">{al.label}</div>
                    <div className="text-xs text-muted-foreground">{al.desc}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="pt-2 border-t border-border">
          <span className="text-xs font-bold uppercase tracking-wide text-primary">AI Maturity</span>
          <div className="grid md:grid-cols-2 gap-3 mt-3">
            <MaturitySelect
              label="AI Usage" value={form.aiUsageLevel} onChange={(v) => update("aiUsageLevel", v)}
              options={[
                { v: "none", l: "No AI tools" },
                { v: "individual", l: "Individual (ChatGPT, Copilot)" },
                { v: "embedded", l: "Embedded in workflows" },
                { v: "agents", l: "Running autonomous agents" },
              ]}
            />
            <MaturitySelect
              label="Governance" value={form.aiGovernance} onChange={(v) => update("aiGovernance", v)}
              options={[
                { v: "none", l: "No policy" },
                { v: "informal", l: "Informal guidelines" },
                { v: "formal", l: "Formal policy" },
                { v: "regulated", l: "Regulated (HIPAA, etc.)" },
              ]}
            />
            <MaturitySelect
              label="Agent Experience" value={form.agentExperience} onChange={(v) => update("agentExperience", v)}
              options={[
                { v: "none", l: "Never deployed" },
                { v: "experimented", l: "Experimented / POC" },
                { v: "production", l: "In production" },
              ]}
            />
            <MaturitySelect
              label="AI Ownership" value={form.aiOwnership} onChange={(v) => update("aiOwnership", v)}
              options={[
                { v: "nobody", l: "No one identified" },
                { v: "it", l: "IT / Engineering" },
                { v: "business", l: "Business leads" },
                { v: "dedicated", l: "Dedicated AI team" },
              ]}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1.5 text-foreground">Biggest Challenges</label>
          <textarea
            value={form.challenges}
            onChange={(e) => update("challenges", e.target.value)}
            placeholder="Where do you waste the most time/money?"
            rows={3}
            className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none border border-border bg-card text-foreground"
          />
        </div>
      </div>
    </div>
  );
}

function FormFunctions({ form, toggleFunction }: {
  form: FormData;
  toggleFunction: (k: string) => void;
}) {
  return (
    <div>
      <h2 className="text-base font-semibold mb-1 text-foreground">Functions to Analyze</h2>
      <p className="text-xs mb-5 text-muted-foreground">Select relevant functions or leave empty for a broad scan.</p>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {FUNCTION_CATEGORIES.map((cat) => (
          <div key={cat.key} className="rounded-lg p-3 border border-border">
            <span className="text-xs font-bold uppercase tracking-wide text-foreground">{cat.name}</span>
            <div className="space-y-1 mt-2">
              {cat.subs.map((sub) => {
                const sel = form.selectedFunctions.includes(sub.key);
                return (
                  <button
                    key={sub.key}
                    onClick={() => toggleFunction(sub.key)}
                    className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors hover:bg-accent/50"
                    style={{ background: sel ? "var(--accent)" : "transparent", color: sel ? "var(--primary)" : undefined, fontWeight: sel ? 600 : 400 }}
                  >
                    <div className={`w-3.5 h-3.5 rounded flex-shrink-0 flex items-center justify-center ${
                      sel ? "bg-primary" : "border border-border"
                    }`}>
                      {sel && (
                        <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <span className={sel ? "text-primary" : "text-muted-foreground"}>{sub.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FormGoals({ form, update }: {
  form: FormData;
  update: <K extends keyof FormData>(k: K, v: FormData[K]) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold mb-1 text-foreground">Goals & Timeline</h2>
        <p className="text-xs text-muted-foreground">Define your investment objectives.</p>
      </div>

      <div>
        <label className="block text-xs font-medium mb-2 text-foreground">Primary Goal</label>
        <div className="flex flex-wrap gap-2">
          {GOALS.map((g) => (
            <Chip key={g} label={g} selected={form.primaryGoal === g} onClick={() => update("primaryGoal", g)} />
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium mb-1.5 text-foreground">Targets / Success Metrics</label>
        <textarea
          value={form.targets}
          onChange={(e) => update("targets", e.target.value)}
          placeholder="e.g. Reduce cost per ticket by 40%, increase ARR by $2M..."
          rows={3}
          className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none border border-border bg-card text-foreground"
        />
      </div>

      <div>
        <label className="block text-xs font-medium mb-2 text-foreground">Timeline</label>
        <div className="flex flex-wrap gap-2">
          {TIMELINES.map((t) => (
            <Chip key={t} label={t} selected={form.timeline === t} onClick={() => update("timeline", t)} />
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium mb-2 text-foreground">Budget Range</label>
        <div className="flex flex-wrap gap-2">
          {BUDGETS.map((b) => (
            <Chip key={b} label={b} selected={form.budgetRange === b} onClick={() => update("budgetRange", b)} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page Component                                                */
/* ------------------------------------------------------------------ */

export function AssessPage() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;

  const [phase, setPhase] = useState<Phase>("start");
  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [formStep, setFormStep] = useState(1);
  const [researching, setResearching] = useState(false);
  const [companySummary, setCompanySummary] = useState("");
  const [webContent, setWebContent] = useState("");
  const [error, setError] = useState("");

  // Deep dive state
  const [rounds, setRounds] = useState<ConversationRound[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState<InterviewResponse | null>(null);
  const [allInsights, setAllInsights] = useState<Array<{ label: string; value: string; icon: string }>>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [customAnswer, setCustomAnswer] = useState("");
  const [clarityScore, setClarityScore] = useState(0);

  // Report state
  const [reportMarkdown, setReportMarkdown] = useState("");
  const [copied, setCopied] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rounds, currentQuestion]);

  const update = <K extends keyof FormData>(key: K, val: FormData[K]) =>
    setForm((p) => ({ ...p, [key]: val }));

  const toggleSystem = (t: string) =>
    setForm((p) => ({
      ...p,
      currentSystems: p.currentSystems.includes(t)
        ? p.currentSystems.filter((x) => x !== t)
        : [...p.currentSystems, t],
    }));

  const toggleFunction = (k: string) =>
    setForm((p) => ({
      ...p,
      selectedFunctions: p.selectedFunctions.includes(k)
        ? p.selectedFunctions.filter((x) => x !== k)
        : [...p.selectedFunctions, k],
    }));

  /* ── Research company ── */
  const researchCompany = useCallback(async () => {
    if (!form.companyUrl || !form.companyName || !companyId) return;
    setResearching(true);
    setError("");
    try {
      const data: ResearchResult = await assessApi.research(companyId, form.companyUrl, form.companyName);
      setCompanySummary(data.summary);
      setWebContent(data.webContent);
      if (data.suggestedIndustry) {
        const matched = INDUSTRIES.find(
          (i) => i.label.toLowerCase() === data.suggestedIndustry.toLowerCase() ||
                 i.slug === toSlug(data.suggestedIndustry)
        );
        if (matched) {
          setForm((p) => ({ ...p, industry: matched.label, industrySlug: matched.slug }));
        } else {
          setForm((p) => ({ ...p, industry: data.suggestedIndustry, industrySlug: toSlug(data.suggestedIndustry) }));
        }
      }
      setPhase("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Research failed");
    } finally {
      setResearching(false);
    }
  }, [form.companyUrl, form.companyName, companyId]);

  /* ── Build form summary for interview ── */
  const buildFormSummary = (f: FormData) =>
    [
      `Company: ${f.companyName} (${f.companyUrl})`,
      `Industry: ${f.industry}`,
      `Scope: ${f.scope || "Entire organization"}`,
      `Size: ${f.employeeRange} employees, Revenue: ${f.revenueRange}`,
      `Systems: ${[...f.currentSystems, f.customSystems].filter(Boolean).join(", ")}`,
      `Automation: ${f.automationLevel}`,
      `AI Usage: ${f.aiUsageLevel || "N/A"}, Governance: ${f.aiGovernance || "N/A"}, Agent Experience: ${f.agentExperience || "N/A"}, AI Owner: ${f.aiOwnership || "N/A"}`,
      `Challenges: ${f.challenges || "N/A"}`,
      `Functions: ${f.selectedFunctions.length > 0 ? f.selectedFunctions.join(", ") : "broad scan"}`,
      `Goal: ${f.primaryGoal}, Targets: ${f.targets || "N/A"}, Timeline: ${f.timeline || "N/A"}, Budget: ${f.budgetRange || "N/A"}`,
    ].join("\n");

  /* ── Start deep dive ── */
  const startDeepDive = useCallback(async () => {
    if (!companyId) return;
    setPhase("deepdive");
    setIsThinking(true);
    setError("");
    try {
      const data: InterviewResponse = await assessApi.interview(companyId, {
        conversationHistory: [],
        companyWebContent: webContent,
        industry: form.industry,
        industrySlug: form.industrySlug || toSlug(form.industry),
        formSummary: buildFormSummary(form),
        selectedFunctions: form.selectedFunctions,
      });
      setCurrentQuestion(data);
      setClarityScore(data.clarityScore);
      if (data.insights?.length) setAllInsights(data.insights);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start interview");
    } finally {
      setIsThinking(false);
    }
  }, [form, webContent, companyId]);

  /* ── Generate report ── */
  const generateReport = useCallback(async (interviewRounds: ConversationRound[]) => {
    if (!companyId) return;
    setPhase("generating");
    setReportMarkdown("");
    const transcript = interviewRounds.map((r, i) => `Q${i + 1}: ${r.question}\nA: ${r.answer}`).join("\n\n");
    try {
      const stream = await assessApi.runAssessment(companyId, {
        companyName: form.companyName,
        industry: form.industry,
        industrySlug: form.industrySlug || toSlug(form.industry),
        description: `${buildFormSummary(form)}\n\nScope: ${form.scope || "Entire organization"}\n\nDeep Dive:\n${transcript}`,
        companyUrl: form.companyUrl,
        employeeRange: form.employeeRange,
        revenueRange: form.revenueRange,
        currentSystems: [...form.currentSystems, form.customSystems].filter(Boolean).join(", "),
        automationLevel: form.automationLevel,
        challenges: form.challenges,
        selectedFunctions: form.selectedFunctions,
        primaryGoal: form.primaryGoal,
        targets: form.targets,
        timeline: form.timeline,
        budgetRange: form.budgetRange,
        aiUsageLevel: form.aiUsageLevel,
        aiGovernance: form.aiGovernance,
        agentExperience: form.agentExperience,
        aiOwnership: form.aiOwnership,
      });
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let out = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
        setReportMarkdown(out);
      }
      setPhase("report");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate report");
      setPhase("deepdive");
    }
  }, [form, companyId]);

  /* ── Submit interview answer ── */
  const submitAnswer = useCallback(async (answer: string) => {
    if (!currentQuestion || isThinking || !companyId) return;
    const round: ConversationRound = {
      question: currentQuestion.question,
      options: currentQuestion.options,
      answer,
      insights: currentQuestion.insights ?? [],
      clarityScore: currentQuestion.clarityScore,
      thinkingSummary: currentQuestion.thinkingSummary,
    };
    const newRounds = [...rounds, round];
    setRounds(newRounds);
    setCustomAnswer("");

    if (currentQuestion.done || newRounds.length >= 5) {
      generateReport(newRounds);
      return;
    }

    setIsThinking(true);
    setCurrentQuestion(null);

    const history: Array<{ role: "assistant" | "user"; content: string }> = [];
    for (const r of newRounds) {
      history.push({ role: "assistant", content: JSON.stringify({ question: r.question, options: r.options }) });
      history.push({ role: "user", content: r.answer });
    }

    try {
      const data: InterviewResponse = await assessApi.interview(companyId, {
        conversationHistory: history,
        companyWebContent: webContent,
        industry: form.industry,
        industrySlug: form.industrySlug || toSlug(form.industry),
        formSummary: buildFormSummary(form),
        selectedFunctions: form.selectedFunctions,
      });
      setCurrentQuestion(data);
      setClarityScore(data.clarityScore);
      if (data.insights?.length) setAllInsights((p) => [...p, ...data.insights]);
      if (data.done) {
        setTimeout(() => generateReport([...newRounds, {
          question: data.question, options: [], answer: "",
          insights: data.insights ?? [], clarityScore: data.clarityScore,
          thinkingSummary: data.thinkingSummary,
        }]), 1500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setIsThinking(false);
    }
  }, [currentQuestion, isThinking, rounds, webContent, form, companyId, generateReport]);

  /* ── Reset ── */
  const handleReset = () => {
    setPhase("start");
    setFormStep(1);
    setForm(INITIAL_FORM);
    setRounds([]);
    setCurrentQuestion(null);
    setAllInsights([]);
    setIsThinking(false);
    setCustomAnswer("");
    setClarityScore(0);
    setWebContent("");
    setCompanySummary("");
    setError("");
    setReportMarkdown("");
  };

  if (!companyId) {
    return <div className="p-6 text-muted-foreground">Select a company to get started.</div>;
  }

  /* ---------------------------------------------------------------- */
  return (
    <div className="min-h-screen bg-background">

      {/* ════ PHASE: START ════ */}
      {phase === "start" && (
        <div className="flex items-center justify-center min-h-screen px-4">
          <div className="max-w-md w-full text-center">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-6 bg-primary shadow-lg">
              <svg className="w-6 h-6 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold mb-3 text-foreground" style={{ letterSpacing: "-0.03em" }}>
              Agent Readiness Assessment
            </h1>
            <p className="text-sm mb-8 text-muted-foreground">
              We'll research your company, then walk you through a quick assessment to identify where AI agents can drive the most impact.
            </p>

            <div className="space-y-3 text-left mb-6">
              <div>
                <label className="block text-xs font-medium mb-1.5 text-foreground">Company Name *</label>
                <input
                  value={form.companyName}
                  onChange={(e) => update("companyName", e.target.value)}
                  placeholder="e.g. Acme Corp"
                  className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring border border-border bg-card text-foreground"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5 text-foreground">Company Website *</label>
                <input
                  value={form.companyUrl}
                  onChange={(e) => update("companyUrl", e.target.value)}
                  placeholder="www.acme.com"
                  className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring border border-border bg-card text-foreground"
                />
              </div>
            </div>

            {error && <p className="text-xs mb-3 text-destructive">{error}</p>}

            <button
              onClick={researchCompany}
              disabled={!form.companyName || !form.companyUrl || researching}
              className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40 bg-primary text-primary-foreground shadow-lg"
            >
              {researching ? (
                <>
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Researching your company...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <circle cx="11" cy="11" r="8" /><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35" />
                  </svg>
                  Find Agents for My Company
                </>
              )}
            </button>
            <p className="text-xs mt-4 text-muted-foreground">~5 minutes total &middot; Personalized report</p>
          </div>
        </div>
      )}

      {/* ════ PHASE: CONFIRM ════ */}
      {phase === "confirm" && (
        <div className="flex items-center justify-center min-h-screen px-4">
          <div className="max-w-lg w-full">
            <div className="rounded-2xl p-6 bg-card border border-border">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-accent border border-border">
                  <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-base font-bold text-foreground">We found {form.companyName}</h2>
                  <p className="text-xs text-muted-foreground">Please confirm this is correct</p>
                </div>
              </div>

              {companySummary && (
                <div className="rounded-xl px-4 py-3 mb-4 bg-accent border border-border">
                  <p className="text-sm leading-relaxed text-muted-foreground">{companySummary}</p>
                </div>
              )}

              {/* Industry */}
              <div className="mb-4">
                <label className="block text-xs font-medium mb-1.5 text-foreground">
                  Industry{" "}
                  {form.industry && <span className="font-normal text-primary">(auto-detected)</span>}
                </label>
                <select
                  value={form.industry}
                  onChange={(e) => {
                    const matched = INDUSTRIES.find((i) => i.label === e.target.value);
                    update("industry", e.target.value);
                    update("industrySlug", matched?.slug ?? toSlug(e.target.value));
                  }}
                  className="w-full px-3 py-2 rounded-lg text-sm border border-border bg-card text-foreground focus:outline-none"
                >
                  <option value="">Select industry...</option>
                  {INDUSTRIES.map((ind) => (
                    <option key={ind.slug} value={ind.label}>{ind.label}</option>
                  ))}
                </select>
              </div>

              {/* Scope */}
              <div className="mb-6">
                <label className="block text-xs font-medium mb-2 text-foreground">Is this assessment for...</label>
                <div className="space-y-2">
                  {SCOPE_OPTIONS.map((opt) => (
                    <button
                      key={opt.v}
                      onClick={() => update("scope", opt.v === "custom" ? "" : opt.l)}
                      className={`w-full text-left px-4 py-2.5 rounded-lg text-sm transition-colors ${
                        form.scope === opt.l
                          ? "border-2 border-primary bg-accent"
                          : "border border-border hover:bg-accent/50"
                      } text-foreground`}
                    >
                      {opt.l}
                    </button>
                  ))}
                  {/* Custom scope input */}
                  {!SCOPE_OPTIONS.slice(0, -1).some((o) => o.l === form.scope) && form.scope !== "" && (
                    <input
                      value={form.scope}
                      onChange={(e) => update("scope", e.target.value)}
                      placeholder="Enter department or business unit name..."
                      className="w-full px-4 py-2.5 rounded-lg text-sm focus:outline-none border border-border bg-card text-foreground mt-2"
                    />
                  )}
                  {form.scope === "" && (
                    <input
                      value={form.scope}
                      onChange={(e) => update("scope", e.target.value)}
                      placeholder="Enter department or business unit name..."
                      className="w-full px-4 py-2.5 rounded-lg text-sm focus:outline-none border border-border bg-card text-foreground mt-2"
                    />
                  )}
                </div>
              </div>

              {error && <p className="text-xs mb-3 text-destructive">{error}</p>}

              <div className="flex gap-3">
                <button
                  onClick={() => setPhase("start")}
                  className="px-4 py-2.5 rounded-lg text-sm font-medium text-muted-foreground border border-border hover:bg-accent/50"
                >
                  Back
                </button>
                <button
                  onClick={() => { if (form.industry && form.scope) setPhase("form"); }}
                  disabled={!form.industry || !form.scope}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-40 bg-primary text-primary-foreground"
                >
                  Continue
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ════ PHASE: FORM (3 steps) ════ */}
      {phase === "form" && (
        <div className="max-w-2xl mx-auto px-4 py-10">
          {/* Step tabs */}
          <div className="flex items-center justify-center gap-1 mb-6">
            {["Operations", "Functions", "Goals"].map((label, i) => (
              <button
                key={label}
                onClick={() => i + 1 < formStep && setFormStep(i + 1)}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium ${
                  formStep === i + 1
                    ? "bg-primary text-primary-foreground"
                    : i + 1 < formStep
                    ? "bg-accent text-primary"
                    : "text-muted-foreground"
                }`}
              >
                {i + 1 < formStep && (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {label}
              </button>
            ))}
          </div>

          <div className="rounded-2xl p-6 bg-card border border-border">
            {formStep === 1 && (
              <FormOperations form={form} update={update} toggleSystem={toggleSystem} />
            )}
            {formStep === 2 && (
              <FormFunctions form={form} toggleFunction={toggleFunction} />
            )}
            {formStep === 3 && (
              <FormGoals form={form} update={update} />
            )}

            <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
              <button
                onClick={() => formStep > 1 ? setFormStep(formStep - 1) : setPhase("confirm")}
                className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent/50"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                Back
              </button>
              {formStep < 3 ? (
                <button
                  onClick={() => setFormStep(formStep + 1)}
                  disabled={formStep === 1 && !form.automationLevel}
                  className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40 bg-primary text-primary-foreground"
                >
                  Next
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={startDeepDive}
                  className="flex items-center gap-1.5 px-5 py-2.5 rounded-lg text-sm font-semibold bg-primary text-primary-foreground shadow-lg"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
                  </svg>
                  Continue to Deep Dive
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ════ PHASE: DEEP DIVE + GENERATING ════ */}
      {(phase === "deepdive" || phase === "generating") && (
        <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-8">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary shadow-md">
                <svg className="w-4 h-4 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
                </svg>
              </div>
              <div>
                <span className="text-sm font-semibold block text-foreground">Deep Dive — {form.companyName}</span>
                <span className="text-xs text-muted-foreground">{form.industry} &middot; {form.scope || "Entire organization"}</span>
              </div>
            </div>
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground border border-border hover:bg-accent/50"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Start Over
            </button>
          </div>

          <div className="grid lg:grid-cols-5 gap-6">
            {/* Chat column */}
            <div className="lg:col-span-3 space-y-4">
              <div className="rounded-xl px-4 py-3 bg-accent border border-border">
                <p className="text-xs text-muted-foreground">
                  We have your company profile, tech stack, and goals. Now a few strategic follow-up questions to refine your assessment.
                </p>
              </div>

              {/* Past rounds */}
              {rounds.map((r, i) => (
                <div key={i}>
                  <div className="flex gap-3 mb-3">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 bg-accent border border-border">
                      <svg className="w-3 h-3 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
                      </svg>
                    </div>
                    <p className="text-sm leading-relaxed flex-1 text-foreground">{r.question}</p>
                  </div>
                  {r.answer && (
                    <div className="flex justify-end mb-2">
                      <div className="px-4 py-2.5 rounded-xl max-w-md bg-primary text-primary-foreground">
                        <p className="text-sm">{r.answer}</p>
                      </div>
                    </div>
                  )}
                  {r.thinkingSummary && (
                    <div className="ml-10 mb-3 px-3 py-2 rounded-lg bg-accent border border-border">
                      <p className="text-xs italic text-muted-foreground">{r.thinkingSummary}</p>
                    </div>
                  )}
                </div>
              ))}

              {/* Current question */}
              {currentQuestion && !currentQuestion.done && phase === "deepdive" && (
                <div>
                  <div className="flex gap-3 mb-4">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 bg-accent border border-border">
                      <svg className="w-3 h-3 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm leading-relaxed mb-4 text-foreground">{currentQuestion.question}</p>
                      <div className="flex flex-wrap gap-2 mb-4">
                        {currentQuestion.options.map((opt) => (
                          <button
                            key={opt}
                            onClick={() => submitAnswer(opt)}
                            disabled={isThinking}
                            className="px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-40 bg-card border border-border text-foreground hover:bg-accent"
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <input
                          value={customAnswer}
                          onChange={(e) => setCustomAnswer(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && customAnswer.trim() && submitAnswer(customAnswer.trim())}
                          placeholder="Or type your own answer..."
                          disabled={isThinking}
                          className="flex-1 px-4 py-2.5 rounded-xl text-sm focus:outline-none disabled:opacity-40 bg-accent border border-border text-foreground"
                        />
                        <button
                          onClick={() => customAnswer.trim() && submitAnswer(customAnswer.trim())}
                          disabled={!customAnswer.trim() || isThinking}
                          className="px-3 py-2.5 rounded-xl disabled:opacity-20 bg-primary text-primary-foreground"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Thinking indicator */}
              {isThinking && (
                <div className="flex gap-3 items-center">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 bg-accent border border-border">
                    <svg className="w-3 h-3 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
                    </svg>
                  </div>
                  <div className="flex gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                  <span className="text-xs text-muted-foreground">Analyzing...</span>
                </div>
              )}

              {/* Generating phase overlay */}
              {phase === "generating" && (
                <div className="rounded-xl p-6 text-center bg-card border border-border">
                  <svg className="animate-spin w-6 h-6 mx-auto mb-3 text-primary" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <p className="text-sm font-medium mb-1 text-foreground">Generating your Agent Readiness Report</p>
                  <p className="text-xs text-muted-foreground">Analyzing against our industry research and your context...</p>
                  {reportMarkdown && (
                    <div className="mt-4 text-left max-h-48 overflow-auto px-4 rounded-lg bg-accent">
                      <p className="text-xs font-mono whitespace-pre-wrap py-2 text-muted-foreground">
                        {reportMarkdown.slice(-400)}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {error && (
                <div className="rounded-xl px-4 py-3 bg-destructive/10 border border-destructive/30">
                  <p className="text-sm text-destructive">{error}</p>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Insights sidebar */}
            <div className="lg:col-span-2">
              <div className="sticky top-20 space-y-4">
                {/* Clarity score ring */}
                <div className="rounded-xl p-5 text-center bg-card border border-border">
                  <div className="relative w-24 h-24 mx-auto mb-3">
                    <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                      <circle cx="50" cy="50" r="45" fill="none" className="stroke-border" strokeWidth="6" />
                      <circle
                        cx="50" cy="50" r="45" fill="none"
                        className="stroke-primary"
                        strokeWidth="6"
                        strokeLinecap="round"
                        strokeDasharray="283"
                        strokeDashoffset={283 - (283 * clarityScore) / 100}
                        style={{ transition: "stroke-dashoffset 0.5s ease" }}
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-2xl font-bold text-foreground">{clarityScore}</span>
                    </div>
                  </div>
                  <p className="text-xs font-medium text-muted-foreground">Assessment Clarity</p>
                  <p className="text-[10px] mt-1 text-muted-foreground">Deep dive {rounds.length} of 5</p>
                </div>

                {/* Insights panel */}
                {allInsights.length > 0 && (
                  <div className="rounded-xl p-4 bg-card border border-border">
                    <p className="text-xs font-bold uppercase tracking-wide mb-3 text-muted-foreground">Insights</p>
                    <div className="space-y-2">
                      {allInsights.map((ins, i) => (
                        <div
                          key={`${ins.label}-${i}`}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-accent border border-border"
                        >
                          <div className="min-w-0">
                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{ins.label}</p>
                            <p className="text-xs font-medium truncate text-foreground">{ins.value}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ════ PHASE: REPORT ════ */}
      {phase === "report" && (
        <div className="max-w-4xl mx-auto px-4 py-8">
          {/* Action buttons */}
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground border border-border hover:bg-accent/50"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              New Assessment
            </button>
            <button
              onClick={() => window.print()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-primary border border-primary/30 hover:bg-primary/10"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Print PDF
            </button>
            <button
              onClick={() => {
                navigator.clipboard.writeText(reportMarkdown);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground border border-border hover:bg-accent/50"
            >
              {copied ? (
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
              {copied ? "Copied!" : "Copy Markdown"}
            </button>
          </div>

          <div className="rounded-2xl overflow-hidden bg-card border border-border">
            {/* Report header */}
            <div className="px-8 py-6 border-b border-border bg-accent">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-primary shadow-md">
                  <svg className="w-5 h-5 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div>
                  <h1 className="text-lg font-bold text-foreground">Agent Readiness Report — {form.companyName}</h1>
                  <p className="text-xs text-muted-foreground">
                    {form.industry} &middot; {form.scope || "Entire organization"} &middot;{" "}
                    {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                  </p>
                </div>
              </div>
            </div>

            {/* Report body */}
            <div className="px-8 py-6">
              <MarkdownBody className="text-foreground">{reportMarkdown}</MarkdownBody>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
