import Link from "next/link";
import { brand } from "@/config/branding";

const tiers = [
  {
    name: "Open Source",
    audience: "Free forever",
    price: "$0",
    priceDetail: null,
    features: [
      "Basic agent management",
      "Issues & goal tracking",
      "Heartbeat scheduling",
      "Community adapters",
      "Single operator",
      "MIT licensed",
    ],
    cta: { label: "Get Started", href: "https://github.com/agentdash-ai/agentdash" },
    highlighted: false,
  },
  {
    name: "Pro",
    audience: "For growing teams",
    price: "From $500/mo",
    priceDetail: "Billed annually. Based on agent count.",
    features: [
      "Everything in Open Source, plus:",
      "Agent Factory & templates",
      "Task dependency DAG",
      "Coordination protocol",
      "Security & policy engine",
      "Hierarchical budgets",
      "Skills registry & versioning",
      "Priority support",
    ],
    cta: { label: "Start Free Trial", href: "/contact" },
    highlighted: true,
  },
  {
    name: "Enterprise",
    audience: "For large organizations",
    price: "Custom",
    priceDetail: "Tailored to your needs",
    features: [
      "Everything in Pro, plus:",
      "AutoResearch engine",
      "Slack, GitHub, Jira integrations",
      "SSO & RBAC",
      "Onboarding engine",
      "Custom adapter development",
      "Dedicated support & SLA",
      "Managed deployment option",
    ],
    cta: { label: "Contact Sales", href: "/contact" },
    highlighted: false,
  },
];

const faqs = [
  {
    question: "Can I self-host?",
    answer:
      "Yes. AgentDash runs on your infrastructure. The open-source core is fully self-hostable with Docker. Pro and Enterprise tiers add a license key for premium features, but everything stays on your servers.",
  },
  {
    question: "What is BYOT?",
    answer:
      "Bring Your Own Tokens. You use your own LLM API keys (OpenAI, Anthropic, etc.) so you maintain full control over costs, rate limits, and data privacy. AgentDash never proxies your LLM traffic.",
  },
  {
    question: "How does agent-based pricing work?",
    answer:
      "Pro is priced by the number of concurrent agents you run. You can spawn and retire agents freely \u2014 billing is based on your peak concurrent count during each billing cycle.",
  },
  {
    question: "Is there a free trial?",
    answer:
      "Yes. Pro comes with a 14-day free trial with full access to all features. No credit card required to start.",
  },
  {
    question: "Can I upgrade or downgrade anytime?",
    answer:
      "Yes, changes take effect on your next billing cycle. You can move between tiers or adjust your agent count at any time from the dashboard.",
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

export default function PricingPage() {
  return (
    <>
      {/* ── Header ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-5xl px-6 pt-28 pb-16 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-text-primary">
          Simple, transparent pricing
        </h1>
        <p className="mt-4 text-lg text-text-secondary max-w-2xl mx-auto">
          From open source to enterprise. Start free, scale when ready.
        </p>
      </section>

      {/* ── Pricing Cards ────────────────────────────────────────── */}
      <section className="mx-auto max-w-5xl px-6 pb-24">
        <div className="grid gap-8 lg:grid-cols-3">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`relative flex flex-col rounded-2xl border bg-white p-8 ${
                tier.highlighted
                  ? "border-2 border-brand-600 shadow-lg"
                  : "border-border"
              }`}
            >
              {/* Most Popular badge */}
              {tier.highlighted && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <span className="inline-block rounded-full bg-brand-600 px-4 py-1 text-xs font-semibold text-white">
                    Most Popular
                  </span>
                </div>
              )}

              <div className="mb-6">
                <h3 className="text-lg font-semibold text-text-primary">{tier.name}</h3>
                <p className="mt-1 text-sm text-text-secondary">{tier.audience}</p>
              </div>

              <div className="mb-6">
                <p className="text-4xl font-bold text-text-primary">{tier.price}</p>
                {tier.priceDetail && (
                  <p className="mt-1 text-sm text-text-muted">{tier.priceDetail}</p>
                )}
              </div>

              <ul className="mb-8 flex-1 space-y-3">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm text-text-secondary">
                    <CheckIcon />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={tier.cta.href}
                className={`block w-full rounded-lg px-4 py-3 text-center text-sm font-semibold transition-colors ${
                  tier.highlighted
                    ? "bg-brand-600 text-white hover:bg-brand-700"
                    : "border border-border text-text-primary hover:bg-surface-secondary"
                }`}
              >
                {tier.cta.label}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* ── FAQ ───────────────────────────────────────────────────── */}
      <section className="border-t border-border bg-surface-secondary">
        <div className="mx-auto max-w-3xl px-6 py-24">
          <h2 className="text-center text-3xl font-bold tracking-tight text-text-primary">
            Frequently asked questions
          </h2>

          <div className="mt-12 space-y-4">
            {faqs.map((faq) => (
              <details
                key={faq.question}
                className="group rounded-xl border border-border bg-white"
              >
                <summary className="flex cursor-pointer items-center justify-between px-6 py-4 text-sm font-semibold text-text-primary">
                  {faq.question}
                  <svg
                    className="h-5 w-5 shrink-0 text-text-muted transition-transform group-open:rotate-180"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </summary>
                <div className="px-6 pb-4 text-sm leading-relaxed text-text-secondary">
                  {faq.answer}
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
