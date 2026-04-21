const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3100";

interface TierCard {
  tier: "free" | "pro" | "enterprise";
  label: string;
  description: string;
  price: string;
  features: string[];
  isPopular?: boolean;
  ctaLabel: string;
  ctaHref: string;
}

const TIERS: TierCard[] = [
  {
    tier: "free",
    label: "Free",
    description: "Try AgentDash at no cost.",
    price: "$0",
    features: [
      "3 agents",
      "1k actions / month",
      "1 pipeline",
    ],
    ctaLabel: "Get started free",
    ctaHref: `${APP_URL}/signup?tier=free`,
  },
  {
    tier: "pro",
    label: "Pro",
    description: "For growing teams shipping with AI.",
    price: "$99/mo",
    features: [
      "25 agents",
      "50k actions / month",
      "10 pipelines",
      "HubSpot sync",
      "AutoResearch",
      "Assess mode",
    ],
    isPopular: true,
    ctaLabel: "Upgrade to Pro",
    ctaHref: `${APP_URL}/signup?tier=pro`,
  },
  {
    tier: "enterprise",
    label: "Enterprise",
    description: "Unlimited scale with dedicated support.",
    price: "$499/mo",
    features: [
      "1000 agents",
      "5M actions / month",
      "1000 pipelines",
      "HubSpot sync",
      "AutoResearch",
      "Assess mode",
      "Priority support",
    ],
    ctaLabel: "Contact sales",
    ctaHref: "mailto:sales@agentdash.com",
  },
];

export default function PricingPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <a href="/" className="font-bold text-lg tracking-tight text-teal-400">
          AgentDash
        </a>
        <div className="flex items-center gap-6 text-sm text-slate-400">
          <a href="/pricing" className="text-slate-100">
            Pricing
          </a>
          <a href="/docs" className="hover:text-slate-100 transition-colors">
            Docs
          </a>
          <a
            href={`${APP_URL}/signup`}
            className="bg-teal-500 hover:bg-teal-400 text-slate-950 font-semibold px-4 py-1.5 rounded-md transition-colors"
          >
            Get started
          </a>
        </div>
      </nav>

      <main className="flex-1 max-w-5xl mx-auto px-6 py-20 w-full">
        <h1 className="text-4xl font-bold text-center mb-4">Simple pricing</h1>
        <p className="text-center text-slate-400 mb-14">
          Start free. Upgrade when your team is ready.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {TIERS.map((t) => (
            <div
              key={t.tier}
              className={`rounded-xl border p-8 flex flex-col ${
                t.isPopular
                  ? "border-teal-500 bg-slate-900 ring-1 ring-teal-500/40"
                  : "border-slate-800 bg-slate-900"
              }`}
            >
              {t.isPopular && (
                <span className="text-xs font-semibold text-teal-400 uppercase tracking-wider mb-3">
                  Most popular
                </span>
              )}
              <h2 className="text-xl font-bold mb-1">{t.label}</h2>
              <p className="text-slate-400 text-sm mb-6">{t.description}</p>

              <div className="text-3xl font-bold mb-8">{t.price}</div>

              <ul className="space-y-3 text-sm text-slate-300 flex-1 mb-8">
                {t.features.map((f) => (
                  <li key={f}>
                    <span className="text-teal-400 mr-2">✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              <a
                href={t.ctaHref}
                className={`block text-center font-semibold py-2.5 rounded-lg transition-colors ${
                  t.isPopular
                    ? "bg-teal-500 hover:bg-teal-400 text-slate-950"
                    : "border border-slate-700 hover:border-slate-500 text-slate-300"
                }`}
              >
                {t.ctaLabel}
              </a>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-slate-500 mt-10">
          Limits shown are display-only. The dashboard enforces canonical entitlements via the server.
        </p>
      </main>

      <footer className="border-t border-slate-800 px-6 py-6 flex items-center justify-between text-sm text-slate-500">
        <a href="/" className="hover:text-slate-300 transition-colors">
          AgentDash
        </a>
        <div className="flex gap-6">
          <a href="/pricing" className="hover:text-slate-300 transition-colors">
            Pricing
          </a>
          <a href="/docs" className="hover:text-slate-300 transition-colors">
            Docs
          </a>
          <a
            href="mailto:sales@agentdash.com"
            className="hover:text-slate-300 transition-colors"
          >
            Contact
          </a>
        </div>
      </footer>
    </div>
  );
}
