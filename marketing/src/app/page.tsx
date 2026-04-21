const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3100";

const FEATURES = [
  {
    title: "Agent Factory",
    description:
      "Spin up role-based AI agents in minutes. Each agent has a defined scope, budget, and set of allowed actions.",
  },
  {
    title: "Pipeline Orchestrator",
    description:
      "Chain agents into multi-step workflows with dependencies, approval gates, and automatic retry logic.",
  },
  {
    title: "Self-driving Workflows",
    description:
      "Agents execute tasks autonomously, escalate when they need human input, and log every action for audit.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <span className="font-bold text-lg tracking-tight text-teal-400">AgentDash</span>
        <div className="flex items-center gap-6 text-sm text-slate-400">
          <a href="/pricing" className="hover:text-slate-100 transition-colors">
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

      {/* Hero */}
      <main className="flex-1">
        <section className="max-w-4xl mx-auto px-6 pt-24 pb-20 text-center">
          <h1 className="text-5xl font-bold leading-tight tracking-tight mb-6">
            Hire AI employees that{" "}
            <span className="text-teal-400">ship</span>
          </h1>
          <p className="text-xl text-slate-400 max-w-2xl mx-auto mb-10">
            AgentDash turns your company's processes into autonomous AI agents.
            Not chatbots — agents that plan, act, and deliver results while you
            stay in control.
          </p>
          <div className="flex items-center justify-center gap-4">
            <a
              href={`${APP_URL}/signup`}
              className="bg-teal-500 hover:bg-teal-400 text-slate-950 font-bold px-8 py-3 rounded-lg text-lg transition-colors"
            >
              Get started free
            </a>
            <a
              href="/pricing"
              className="border border-slate-700 hover:border-slate-500 text-slate-300 px-8 py-3 rounded-lg text-lg transition-colors"
            >
              See pricing
            </a>
          </div>
        </section>

        {/* Feature cards */}
        <section className="max-w-5xl mx-auto px-6 pb-24">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="bg-slate-900 border border-slate-800 rounded-xl p-6"
              >
                <h3 className="font-semibold text-teal-400 mb-2">{f.title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">
                  {f.description}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 px-6 py-6 flex items-center justify-between text-sm text-slate-500">
        <span>© {new Date().getFullYear()} AgentDash</span>
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
