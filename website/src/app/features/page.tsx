import { brand } from "@/config/branding";

const sections = [
  {
    title: "Agent Factory",
    description:
      "Dynamically spawn, configure, and retire AI agents on demand. Scale your workforce up to meet deadlines, then scale down to save costs \u2014 all without manual intervention.",
    bullets: [
      "Dynamic agent spawning with role-based templates",
      "OKRs and KPIs assigned per agent",
      "Capacity planning and auto-scaling policies",
      "Lifecycle management from onboarding to retirement",
    ],
  },
  {
    title: "Task Intelligence",
    description:
      "A DAG-based task engine that understands dependencies, detects bottlenecks, and keeps every agent working on the highest-impact item at all times.",
    bullets: [
      "Dependency DAG with automatic unblocking",
      "Critical path analysis and priority scoring",
      "Coordination protocol for multi-agent handoffs",
      "Real-time progress tracking and alerts",
    ],
  },
  {
    title: "Security & Governance",
    description:
      "Enterprise-grade controls that let you move fast without losing sleep. Every action is auditable, every agent is sandboxed, and you hold the kill switch.",
    bullets: [
      "Policy engine with declarative rule sets",
      "Runtime sandboxes with resource limits",
      "One-click kill switch for any agent",
      "Tamper-proof audit trail and BYOT architecture",
    ],
  },
  {
    title: "Budget Management",
    description:
      "Hierarchical budgets that mirror your org chart. Set limits at the team, project, or agent level \u2014 and get alerted before anything overspends.",
    bullets: [
      "Hierarchical budgets across org units",
      "Spend forecasting and burn-rate alerts",
      "ROI tracking per agent and project",
      "Multi-resource accounting (tokens, compute, API calls)",
    ],
  },
  {
    title: "Human-Agent Collaboration",
    description:
      "Agents work where your team already works. They open PRs, post in Slack, create Jira tickets, and escalate to humans when judgment is needed.",
    bullets: [
      "Native Slack, GitHub, and Jira integrations",
      "Configurable escalation policies",
      "Async handoffs with context preservation",
      "Human-in-the-loop approval gates",
    ],
  },
  {
    title: "AutoResearch",
    description:
      "Hypothesis-driven experiment loops that turn data into decisions. Agents propose experiments, run them, measure results, and iterate \u2014 all tied to business goals.",
    bullets: [
      "Hypothesis generation and validation loops",
      "Metrics integration with your data stack",
      "Full experiment lifecycle management",
      "Guardrails to prevent runaway experiments",
    ],
  },
];

function CheckIcon() {
  return (
    <svg
      className="h-5 w-5 shrink-0 text-brand-600"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

export default function FeaturesPage() {
  return (
    <>
      {/* ── Header ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 pt-28 pb-16 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-text-primary">
          Built for enterprise AI orchestration
        </h1>
        <p className="mt-4 text-lg text-text-secondary max-w-2xl mx-auto">
          Everything you need to deploy, manage, and govern autonomous AI agent
          teams \u2014 on your infrastructure, with your LLM keys.
        </p>
      </section>

      {/* ── Feature Sections ─────────────────────────────────────── */}
      <div className="mx-auto max-w-6xl px-6 pb-24">
        {sections.map((section, idx) => {
          const isReversed = idx % 2 === 1;
          const isLast = idx === sections.length - 1;

          return (
            <section
              key={section.title}
              className={`py-16 ${!isLast ? "border-b border-border" : ""}`}
            >
              <div
                className={`grid items-center gap-12 lg:grid-cols-2 ${
                  isReversed ? "lg:direction-rtl" : ""
                }`}
              >
                {/* Text */}
                <div className={isReversed ? "lg:order-2" : ""}>
                  <h2 className="text-2xl font-bold tracking-tight text-text-primary">
                    {section.title}
                  </h2>
                  <p className="mt-4 leading-relaxed text-text-secondary">
                    {section.description}
                  </p>
                  <ul className="mt-6 space-y-3">
                    {section.bullets.map((bullet) => (
                      <li
                        key={bullet}
                        className="flex items-start gap-3 text-sm text-text-secondary"
                      >
                        <CheckIcon />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Placeholder visual */}
                <div className={isReversed ? "lg:order-1" : ""}>
                  <div className="flex h-64 items-center justify-center rounded-xl border border-border bg-surface-secondary">
                    <span className="text-sm text-text-muted">
                      Screenshot coming soon
                    </span>
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
