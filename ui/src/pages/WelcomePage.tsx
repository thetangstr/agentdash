"use client";

import { useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  Building2,
  ChartNoAxesCombined,
  CircleGauge,
  Clock3,
  Rocket,
  ServerCog,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCompany } from "../context/CompanyContext";

type FeatureCard = {
  title: string;
  description: string;
  icon: LucideIcon;
};

type AudienceCard = {
  title: string;
  description: string;
  outcomes: string[];
  icon: LucideIcon;
};

type DeploymentCard = {
  title: string;
  description: string;
  badge: string;
  points: string[];
  icon: LucideIcon;
};

const valueProps: FeatureCard[] = [
  {
    title: "See the whole operation",
    description:
      "Track what every agent is doing, what it costs, and where work is blocked without digging through terminals.",
    icon: ChartNoAxesCombined,
  },
  {
    title: "Keep humans in control",
    description:
      "Approval gates, budget guardrails, and clear audit history make AI work easier to trust across a real business.",
    icon: ShieldCheck,
  },
  {
    title: "Deploy the way your buyers buy",
    description:
      "Start local, run on a Mac mini, or move into a private cloud deployment when the team needs more structure.",
    icon: ServerCog,
  },
];

const audiences: AudienceCard[] = [
  {
    title: "CTOs and technical operators",
    description:
      "Run AI work with the visibility, governance, and vendor flexibility your leadership team expects.",
    outcomes: ["Budget controls by default", "Approval checkpoints for risky work", "A board-level view of execution"],
    icon: Building2,
  },
  {
    title: "Agencies and client-service teams",
    description:
      "Manage repeatable delivery across research, content, engineering, and operations without multiplying headcount.",
    outcomes: ["Standardized workflows per client", "Clear ownership across agent teams", "Faster delivery with fewer handoffs"],
    icon: BriefcaseBusiness,
  },
  {
    title: "SMB teams without deep technical staff",
    description:
      "Get the benefits of coordinated AI work in a setup that feels guided, structured, and approachable.",
    outcomes: ["Simple onboarding", "Readable progress updates", "One place to start and supervise work"],
    icon: Sparkles,
  },
];

const deploymentOptions: DeploymentCard[] = [
  {
    title: "Start local",
    description: "Ideal for founders, small teams, and fast pilots that need results before process.",
    badge: "Fastest path",
    points: ["Runs on your machine", "No-login local setup", "Best for first success and demos"],
    icon: Rocket,
  },
  {
    title: "Run on a Mac mini",
    description: "A strong option for agencies or offices that want a dedicated, tangible AI operations box.",
    badge: "Easy to own",
    points: ["Shared in-office control", "Low ops overhead", "Great for private always-on usage"],
    icon: CircleGauge,
  },
  {
    title: "Move to private cloud",
    description: "The right fit when buyers need authentication, controlled access, and a cleaner IT story.",
    badge: "Best for teams",
    points: ["Login-required access", "Private network or VPC ready", "Fits mid-market procurement better"],
    icon: ServerCog,
  },
];

const setupSteps = [
  {
    step: "01",
    title: "Name the company",
    description: "Start with one guided setup flow instead of stitching together prompts, scripts, and dashboards.",
  },
  {
    step: "02",
    title: "Choose how agents run",
    description: "Use local tooling first, then expand into more structured deployments when the team is ready.",
  },
  {
    step: "03",
    title: "Operate from one board",
    description: "See activity, approvals, tasks, and spend in one place that leadership can actually understand.",
  },
];

export function WelcomePage() {
  const { createCompany } = useCompany();
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  async function handleGetStarted() {
    if (submittingRef.current) return;
    const name = companyName.trim();
    if (!name) return;
    submittingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const company = await createCompany({ name });
      navigate(`/${company.issuePrefix}/setup-wizard`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
      submittingRef.current = false;
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="h-screen overflow-y-auto bg-[linear-gradient(180deg,#f7fbff_0%,#f6f8fc_34%,#ffffff_100%)] text-slate-950"
      style={{ fontFamily: '"Avenir Next", Inter, ui-sans-serif, system-ui, sans-serif' }}
    >
      <div className="relative isolate overflow-hidden">
        <div className="absolute inset-x-0 top-0 -z-10 h-[34rem] bg-[radial-gradient(circle_at_top_left,rgba(79,140,255,0.18),transparent_42%),radial-gradient(circle_at_top_right,rgba(12,186,156,0.14),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.88),rgba(255,255,255,0))]" />
        <div className="absolute left-[-6rem] top-28 -z-10 h-72 w-72 rounded-full bg-sky-200/30 blur-3xl" />
        <div className="absolute right-[-5rem] top-18 -z-10 h-80 w-80 rounded-full bg-teal-200/30 blur-3xl" />

        <div className="mx-auto flex max-w-7xl flex-col px-6 pb-20 pt-7 lg:px-10">
          <header className="flex flex-col gap-5 border-b border-slate-200/70 pb-6 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/70 bg-white/90 shadow-[0_18px_40px_-20px_rgba(34,87,122,0.35)]">
                <Bot className="h-6 w-6 text-sky-700" />
              </div>
              <div>
                <p className="text-lg font-semibold tracking-tight text-slate-900">AgentDash</p>
                <p className="text-sm text-slate-600">Premium control for AI work that needs adult supervision.</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 text-xs font-medium text-slate-700">
              <span className="rounded-full border border-slate-200 bg-white/85 px-3 py-1.5">Mid-market ready</span>
              <span className="rounded-full border border-slate-200 bg-white/85 px-3 py-1.5">Agency friendly</span>
              <span className="rounded-full border border-slate-200 bg-white/85 px-3 py-1.5">Simple enough for SMB</span>
            </div>
          </header>

          <main className="space-y-18 pb-10 pt-10 md:space-y-24 md:pt-14">
            <section className="grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_25rem] lg:items-start">
              <div className="space-y-8">
                <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-white/85 px-4 py-2 text-sm font-medium text-sky-900 shadow-sm">
                  <Clock3 className="h-4 w-4" />
                  Designed to get teams to first value in under five minutes
                </div>

                <div className="max-w-3xl space-y-5">
                  <h1
                    className="max-w-4xl text-5xl font-semibold tracking-[-0.04em] text-slate-950 md:text-6xl"
                    style={{ fontFamily: '"Iowan Old Style", "Palatino Linotype", Georgia, serif' }}
                  >
                    The easiest way to run AI work like a real operating team.
                  </h1>
                  <p className="max-w-2xl text-lg leading-8 text-slate-600 md:text-xl">
                    AgentDash gives CTOs, agencies, and growing businesses one premium control surface for AI work:
                    setup, approvals, budgets, activity, and outcomes in a product that feels polished instead of
                    improvised.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-3xl border border-slate-200 bg-white/90 p-4 shadow-[0_20px_45px_-30px_rgba(15,23,42,0.35)]">
                    <p className="text-sm font-semibold text-slate-900">Easy to explain</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">A board-level UI that non-technical buyers can understand quickly.</p>
                  </div>
                  <div className="rounded-3xl border border-slate-200 bg-white/90 p-4 shadow-[0_20px_45px_-30px_rgba(15,23,42,0.35)]">
                    <p className="text-sm font-semibold text-slate-900">Safe by default</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">Approval gates and spend visibility keep autonomy useful instead of risky.</p>
                  </div>
                  <div className="rounded-3xl border border-slate-200 bg-white/90 p-4 shadow-[0_20px_45px_-30px_rgba(15,23,42,0.35)]">
                    <p className="text-sm font-semibold text-slate-900">Deployment flexibility</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">Local, Mac mini, or private cloud depending on how your team buys software.</p>
                  </div>
                </div>
              </div>

              <div className="space-y-5">
                <Card className="overflow-hidden rounded-[2rem] border-slate-200/80 bg-white/92 py-0 shadow-[0_28px_80px_-32px_rgba(15,23,42,0.28)]">
                  <div className="border-b border-slate-200/80 bg-[linear-gradient(135deg,rgba(239,248,255,0.95),rgba(255,255,255,0.95))] px-7 py-6">
                    <p className="text-sm font-semibold uppercase tracking-[0.22em] text-sky-700">Start here</p>
                    <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">Launch your first company</h2>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Name the company, kick off setup, and move from blank slate to supervised AI work in one guided flow.
                    </p>
                  </div>

                  <CardContent className="space-y-5 px-7 py-7">
                    <div className="space-y-2">
                      <label htmlFor="company-name" className="text-sm font-medium text-slate-800">
                        Company name
                      </label>
                      <Input
                        id="company-name"
                        type="text"
                        placeholder="Northstar Studio"
                        value={companyName}
                        onChange={(event) => setCompanyName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") handleGetStarted();
                        }}
                        className="h-12 rounded-2xl border-slate-200 bg-white px-4 text-sm shadow-none"
                        autoFocus
                      />
                    </div>

                    {error ? <p className="text-sm text-destructive">{error}</p> : null}

                    <Button
                      onClick={handleGetStarted}
                      disabled={!companyName.trim() || loading}
                      size="lg"
                      className="h-12 w-full rounded-2xl bg-sky-700 text-base font-semibold text-white hover:bg-sky-800"
                    >
                      {loading ? "Setting up..." : "Create company and continue"}
                      <ArrowRight className="h-4 w-4" />
                    </Button>

                    <div className="rounded-3xl border border-slate-200 bg-slate-50/80 p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">What happens next</p>
                      <div className="mt-4 space-y-3">
                        {setupSteps.map((item) => (
                          <div key={item.step} className="flex gap-3">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-slate-900 shadow-sm">
                              {item.step}
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                              <p className="text-sm leading-6 text-slate-600">{item.description}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-1 text-sm text-slate-600">
                      <span>Need a deployment path before you start?</span>
                      <a href="#deployment" className="font-medium text-sky-700 transition hover:text-sky-800">
                        Review deployment options
                      </a>
                    </div>
                  </CardContent>
                </Card>

                <div className="rounded-[2rem] border border-slate-200/80 bg-slate-950 p-5 text-white shadow-[0_24px_60px_-30px_rgba(15,23,42,0.55)]">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-200/80">Board preview</p>
                      <p className="mt-2 text-lg font-semibold">Clear enough for leadership, detailed enough for operators.</p>
                    </div>
                    <div className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white/80">Live</div>
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-white/55">Activity</p>
                      <p className="mt-3 text-sm font-medium text-white">CEO approved new delivery workflow</p>
                      <p className="mt-2 text-xs leading-5 text-white/65">Budget still within target. Two agents active. One task pending review.</p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-white/55">Controls</p>
                      <p className="mt-3 text-sm font-medium text-white">Approval gates and spend policies active</p>
                      <p className="mt-2 text-xs leading-5 text-white/65">No hidden burn. Operators can pause, approve, or redirect work quickly.</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section id="value" className="space-y-6">
              <div className="max-w-2xl space-y-3">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">Why teams buy</p>
                <h2 className="text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                  Premium software feel. Practical operations value.
                </h2>
                <p className="text-lg leading-8 text-slate-600">
                  Buyers do not want another demo that feels magical for five minutes and fragile after that. They want
                  AI operations that look credible in front of customers, finance, and leadership.
                </p>
              </div>

              <div className="grid gap-5 lg:grid-cols-3">
                {valueProps.map(({ title, description, icon: Icon }) => (
                  <Card
                    key={title}
                    className="rounded-[2rem] border-slate-200/80 bg-white/88 py-0 shadow-[0_25px_60px_-35px_rgba(15,23,42,0.25)]"
                  >
                    <CardContent className="space-y-4 px-6 py-6">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-sky-700">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="space-y-2">
                        <h3 className="text-xl font-semibold tracking-tight text-slate-950">{title}</h3>
                        <p className="text-sm leading-7 text-slate-600">{description}</p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>

            <section id="audience" className="space-y-6">
              <div className="max-w-3xl space-y-3">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">Built for real buyers</p>
                <h2 className="text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                  Different audiences. One product story.
                </h2>
                <p className="text-lg leading-8 text-slate-600">
                  The message changes by buyer, but the value stays consistent: easier setup, better visibility, and
                  more confidence in how AI work is run.
                </p>
              </div>

              <div className="grid gap-5 xl:grid-cols-3">
                {audiences.map(({ title, description, outcomes, icon: Icon }) => (
                  <Card
                    key={title}
                    className="rounded-[2rem] border-slate-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(247,250,252,0.94))] py-0 shadow-[0_24px_64px_-36px_rgba(15,23,42,0.28)]"
                  >
                    <CardContent className="space-y-5 px-6 py-6">
                      <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-950 text-white">
                          <Icon className="h-5 w-5" />
                        </div>
                        <h3 className="text-xl font-semibold tracking-tight text-slate-950">{title}</h3>
                      </div>

                      <p className="text-sm leading-7 text-slate-600">{description}</p>

                      <div className="space-y-2">
                        {outcomes.map((outcome) => (
                          <div key={outcome} className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
                            <div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-teal-500" />
                            <p className="text-sm leading-6 text-slate-700">{outcome}</p>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>

            <section id="deployment" className="grid gap-8 lg:grid-cols-[0.92fr_1.08fr]">
              <div className="space-y-4">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">Flexible deployment</p>
                <h2 className="text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                  Start simple. Upgrade the deployment story when the buyer does.
                </h2>
                <p className="text-lg leading-8 text-slate-600">
                  This page should reassure all three audiences at once: the operator who wants speed, the agency that
                  wants an easy dedicated box, and the CTO who needs a clean private-cloud narrative.
                </p>
              </div>

              <div className="grid gap-4">
                {deploymentOptions.map(({ title, description, badge, points, icon: Icon }) => (
                  <div
                    key={title}
                    className="rounded-[2rem] border border-slate-200 bg-white/88 p-6 shadow-[0_22px_50px_-34px_rgba(15,23,42,0.24)]"
                  >
                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                      <div className="flex gap-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-sky-700">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div className="space-y-2">
                          <h3 className="text-xl font-semibold tracking-tight text-slate-950">{title}</h3>
                          <p className="text-sm leading-7 text-slate-600">{description}</p>
                        </div>
                      </div>
                      <div className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">
                        {badge}
                      </div>
                    </div>

                    <div className="mt-4 grid gap-2 md:grid-cols-3">
                      {points.map((point) => (
                        <div key={point} className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
                          {point}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[2.25rem] border border-slate-200 bg-slate-950 px-6 py-8 text-white shadow-[0_26px_80px_-36px_rgba(15,23,42,0.6)] md:px-8 md:py-10">
              <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
                <div className="max-w-3xl space-y-4">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-200">Make the first impression count</p>
                  <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
                    A landing page that sells confidence before the product even loads.
                  </h2>
                  <p className="text-lg leading-8 text-white/72">
                    This welcome surface now speaks to the actual buying committee: operationally credible for CTOs,
                    polished enough for agencies, and approachable enough for smaller businesses that just want to get
                    started.
                  </p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
                  <Button
                    onClick={handleGetStarted}
                    disabled={!companyName.trim() || loading}
                    size="lg"
                    className="h-12 rounded-2xl bg-white px-6 font-semibold text-slate-950 hover:bg-slate-100"
                  >
                    {loading ? "Setting up..." : "Start setup now"}
                  </Button>
                  <Button asChild size="lg" variant="ghost" className="h-12 rounded-2xl border border-white/15 text-white hover:bg-white/10">
                    <a href="#deployment">See deployment options</a>
                  </Button>
                </div>
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
