import Link from "next/link";
import { brand } from "@/config/branding";

const stats = [
  { label: "Deploy in Minutes", detail: "On your infrastructure" },
  { label: "Unlimited Agents", detail: "Scale on demand" },
  { label: "BYOT", detail: "Bring your own tokens" },
  { label: "100% Open Core", detail: "MIT licensed foundation" },
];

const features = [
  {
    title: "Agent Factory",
    description:
      "Dynamically spawn, configure, and retire agents. Scale teams up to meet deadlines with role-based templates.",
  },
  {
    title: "Task Dependencies",
    description:
      "DAG-based task management with automatic unblocking. Agents know what to work on next.",
  },
  {
    title: "Security & Governance",
    description:
      "Policy engine, runtime sandboxes, kill switches, and tamper-proof audit trails.",
  },
  {
    title: "Smart Budgets",
    description:
      "Hierarchical budgets with forecasting, ROI tracking, and multi-resource accounting.",
  },
  {
    title: "Human-Agent Collaboration",
    description:
      "Agents work in your existing tools \u2014 Slack, GitHub, Jira. Not a separate dashboard.",
  },
  {
    title: "AutoResearch",
    description:
      "Hypothesis-driven experiment loops. Build, measure, learn \u2014 tied to measurable business goals.",
  },
];

const steps = [
  {
    number: 1,
    title: "Deploy",
    description:
      "Run AgentDash on your infrastructure with a single docker command. Bring your own LLM tokens.",
  },
  {
    number: 2,
    title: "Onboard",
    description:
      "AgentDash learns your company \u2014 domain, goals, workflows, team structure.",
  },
  {
    number: 3,
    title: "Build Your Team",
    description:
      "Use the Agent Factory to spawn agents from templates. Set OKRs, assign skills, define boundaries.",
  },
  {
    number: 4,
    title: "Ship",
    description:
      "Agents collaborate on tasks, report progress, and escalate to humans when needed.",
  },
];

export default function HomePage() {
  return (
    <>
      {/* ── Hero Section ──────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-brand-50/50 to-surface" />
        <div className="relative mx-auto max-w-5xl px-6 py-24 sm:py-32 text-center">
          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-text-primary">
            {brand.tagline}
          </h1>
          <p className="mt-6 text-xl text-text-secondary max-w-2xl mx-auto leading-relaxed">
            {brand.description}
          </p>
          <div className="mt-10 flex items-center justify-center gap-4 flex-wrap">
            <Link
              href="/contact"
              className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 transition-colors"
            >
              Get Started
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-lg border border-border px-6 py-3 text-sm font-semibold text-text-primary hover:bg-surface-secondary transition-colors"
            >
              View Pricing
            </Link>
          </div>
        </div>
      </section>

      {/* ── Stats Bar ─────────────────────────────────────────────── */}
      <section className="mx-auto max-w-5xl px-6 -mt-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-2xl border border-border bg-border overflow-hidden">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="bg-surface-secondary px-6 py-8 text-center"
            >
              <p className="text-sm font-semibold text-text-primary">
                {stat.label}
              </p>
              <p className="mt-1 text-sm text-text-muted">{stat.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features Grid ─────────────────────────────────────────── */}
      <section className="mx-auto max-w-5xl px-6 py-24 sm:py-32">
        <div className="text-center max-w-2xl mx-auto">
          <h2 className="text-3xl font-bold tracking-tight text-text-primary">
            Everything you need to run AI agent teams
          </h2>
          <p className="mt-4 text-lg text-text-secondary">
            From a single agent to an entire AI workforce &mdash; with the
            governance your enterprise demands.
          </p>
        </div>

        <div className="mt-16 grid sm:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-border bg-white p-6"
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50">
                <div className="h-3 w-3 rounded-full bg-brand-500" />
              </div>
              <h3 className="font-semibold text-text-primary">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How It Works ──────────────────────────────────────────── */}
      <section className="bg-surface-secondary border-y border-border">
        <div className="mx-auto max-w-3xl px-6 py-24 sm:py-32">
          <h2 className="text-center text-3xl font-bold tracking-tight text-text-primary">
            Up and running in four steps
          </h2>

          <div className="mt-16 space-y-12">
            {steps.map((step, idx) => (
              <div key={step.number} className="flex gap-6">
                <div className="flex flex-col items-center">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">
                    {step.number}
                  </div>
                  {idx < steps.length - 1 && (
                    <div className="mt-3 w-px flex-1 bg-border" />
                  )}
                </div>
                <div className="pb-2">
                  <h3 className="font-semibold text-text-primary">
                    {step.title}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                    {step.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA Section ───────────────────────────────────────────── */}
      <section className="bg-text-primary">
        <div className="mx-auto max-w-5xl px-6 py-24 sm:py-32 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-white">
            Ready to orchestrate your AI workforce?
          </h2>
          <div className="mt-10 flex items-center justify-center gap-4 flex-wrap">
            <Link
              href="/contact"
              className="inline-flex items-center justify-center rounded-lg bg-white px-6 py-3 text-sm font-semibold text-text-primary shadow-sm hover:bg-surface-secondary transition-colors"
            >
              Request a Demo
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-lg border border-white/30 px-6 py-3 text-sm font-semibold text-white hover:bg-white/10 transition-colors"
            >
              View Pricing
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
