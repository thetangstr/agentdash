import { Fragment, useLayoutEffect, useRef } from "react";
import {
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  CircleDot,
  ClipboardList,
  Database,
  FileText,
  Goal,
  Inbox,
  KeyRound,
  Laptop,
  Layers3,
  MessageSquare,
  Network,
  Send,
  Sparkles,
  TrendingUp,
  Users,
  Workflow,
} from "lucide-react";
import type { CSSProperties, ComponentType, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type DeckStyle = CSSProperties & Record<`--${string}`, string>;

const lightDeckTheme: DeckStyle = {
  colorScheme: "light",
  "--background": "oklch(1 0 0)",
  "--foreground": "oklch(0.145 0 0)",
  "--card": "oklch(1 0 0)",
  "--card-foreground": "oklch(0.145 0 0)",
  "--popover": "oklch(1 0 0)",
  "--popover-foreground": "oklch(0.145 0 0)",
  "--primary": "oklch(0.205 0 0)",
  "--primary-foreground": "oklch(0.985 0 0)",
  "--secondary": "oklch(0.97 0 0)",
  "--secondary-foreground": "oklch(0.205 0 0)",
  "--muted": "oklch(0.97 0 0)",
  "--muted-foreground": "oklch(0.556 0 0)",
  "--accent": "oklch(0.97 0 0)",
  "--accent-foreground": "oklch(0.205 0 0)",
  "--destructive": "oklch(0.577 0.245 27.325)",
  "--destructive-foreground": "oklch(0.577 0.245 27.325)",
  "--border": "oklch(0.922 0 0)",
  "--input": "oklch(0.922 0 0)",
  "--ring": "oklch(0.708 0 0)",
  "--surface-page": "#FAF9F6",
  "--surface-raised": "#FFFFFF",
  "--surface-sunken": "#F1EFEA",
  "--border-soft": "#E8E5DD",
  "--border-strong": "#C7C2B5",
  "--text-primary": "#1F1B16",
  "--text-secondary": "#5A544A",
  "--text-tertiary": "#8C8678",
  "--text-inverse": "#FAF9F6",
};

const levels = [
  {
    level: "0",
    name: "Personal Local Agent",
    headline: "Individual leverage, no shared operating memory.",
    example: "A personal AI assistant on your computer.",
    context: "Personal files, pasted text, local repo context, and whatever the individual user provides.",
    trust: "Individual experimentation only.",
    capability: "Personal drafting, coding, analysis, and brainstorming with no shared operating memory.",
    controls: "Personal judgment, copy and paste, manual review.",
    implementation: "Use frontier lab LLM models to power personal agents; document current usage, risks, and workflows worth centralizing.",
    time: "Already happening",
    needs: ["A laptop", "Tokens", "A model account", "Manual context sharing"],
    outcomes: ["Personal drafts", "Local code help", "One-off analysis"],
    graphic: {
      leftTitle: "Personal inputs",
      left: [
        { label: "Prompt", icon: MessageSquare },
        { label: "Local repo", icon: Laptop },
        { label: "Pasted docs", icon: FileText },
      ],
      center: { label: "Personal AI", icon: Bot },
      rightTitle: "Personal outputs",
      right: [
        { label: "Draft", icon: ClipboardList },
        { label: "Answer", icon: Sparkles },
        { label: "Manual handoff", icon: Send },
      ],
    },
  },
  {
    level: "1",
    name: "Communicable Agent",
    headline: "A shared conversation where multiple humans can talk to the same agent.",
    example: "A gateway agent reachable through a group chat or internal collaboration layer.",
    context: "Thread context, files, snippets, and company facts contributed by multiple participants.",
    trust: "Can build understanding from the group conversation, but still depends on what humans bring into the thread.",
    capability: "Answers the group, remembers thread context, drafts shared outputs, and asks for missing company context.",
    controls: "Invite agent, add people, attach context, ask for draft, stop thread.",
    implementation: "Use frontier lab LLM models to power the shared agent; stand up the gateway, preserve thread context, and log messages.",
    time: "1-2 weeks",
    needs: ["Gateway", "Tokens", "Shared thread", "Identity map"],
    outcomes: [
      "Mac mini on your company network",
      "Access to shared knowledge base",
      "Access to the collaboration layer as an agent*",
    ],
    footnote: "*To be validated. Collaboration access requires the right tenant permissions to be granted.",
    graphic: {
      leftTitle: "Shared conversation",
      left: [
        { label: "Human 1", icon: Users },
        { label: "Human 2", icon: Users },
        { label: "Company context", icon: ClipboardList },
      ],
      center: { label: "Gateway agent", icon: Network },
      rightTitle: "Agent responses",
      right: [
        { label: "Shared answer", icon: Sparkles },
        { label: "Group draft", icon: FileText },
        { label: "Missing context", icon: ArrowRight },
      ],
    },
  },
  {
    level: "2",
    name: "Company-Aware Gateway Agent",
    headline: "Level 1 plus approved company knowledge: the shared gateway agent can now ground answers in firm sources.",
    example: "A gateway agent with access to company-wide approved data.",
    context: "Everything from Level 1: multiple humans, shared thread context, files, snippets, and company facts, plus a shared company knowledge database.",
    trust: "Can hold the shared conversation and search approved company knowledge without acting across systems.",
    capability: "Answers the same group from source-grounded company memory, prepares briefs, compares opportunities, reuses past work, and identifies gaps.",
    controls: "Invite people, connect knowledge database, review sources, remove source, run brief.",
    implementation: "Use frontier lab LLM models to power grounded answers; create a scoped context room, index approved materials, and show source traces.",
    time: "2-3 weeks",
    needs: ["Level 1 gateway", "Tokens", "Shared company database", "Source trace"],
    outcomes: [
      "Level 1 shared conversation content",
      "Access to a shared company database",
      "Shared file drives, wiki pages, project docs, and proposal repositories",
    ],
    graphic: {
      leftTitle: "Level 1 inputs",
      left: [
        { label: "Human 1", icon: Users },
        { label: "Human 2", icon: Users },
        { label: "Thread context", icon: MessageSquare },
      ],
      center: { label: "Gateway agent", icon: Network },
      centerAddon: { label: "Company knowledge database", icon: Database },
      rightTitle: "Useful artifacts",
      right: [
        { label: "Cited brief", icon: ClipboardList },
        { label: "Comparison", icon: Layers3 },
        { label: "Open questions", icon: CircleDot },
      ],
    },
  },
  {
    level: "3",
    name: "Managed Agent Operating System",
    headline: "Autonomous agents complete tasks against goals and OKRs.",
    example: "AgentDash / Paperclip.",
    context: "Company knowledge, goals, OKRs, projects, issues, approvals, and selected live sources.",
    trust: "Can coordinate multiple agents inside governed work boundaries.",
    capability: "Autonomous agents complete tasks based on goals and OKRs, escalate approvals, and leave a trace.",
    controls: "Set goals, assign agents, approve actions, view trace, pause autonomy.",
    implementation: "Use frontier lab LLM models to power autonomous agents; stand up goals, roles, routing, approvals, telemetry, and governed autonomy.",
    time: "3-9 weeks",
    needs: ["Goals and OKRs", "Tokens", "Agent roles", "Approval gates"],
    outcomes: [
      "Everything from Level 2",
      "AgentDash or equivalent agent operating system",
      "Cloud or local deployment",
    ],
    graphic: {
      leftTitle: "Operating model",
      left: [
        { label: "Goals", icon: Goal },
        { label: "OKRs", icon: TrendingUp },
        { label: "Projects", icon: BriefcaseBusiness },
      ],
      center: { label: "Agent OS", icon: Workflow },
      centerItems: [
        { label: "Agents", icon: Bot },
        { label: "Approvals", icon: KeyRound },
        { label: "Trace", icon: ClipboardList },
      ],
      rightTitle: "Outcomes + deliverables",
      right: [
        { label: "Qualified RFP packages", icon: BriefcaseBusiness },
        { label: "Admin pilot charters", icon: ClipboardList },
        { label: "Executive briefings", icon: FileText },
      ],
    },
  },
  {
    level: "4",
    name: "Executive Chief of Staff",
    headline: "Level 3 plus approved executive context and access.",
    example: "A CoS that can use the Level 3 agent operating system with delegated executive context and access.",
    context: "Everything from Level 3: goals, agents, approvals, traces, and managed execution, plus the executive's approved inbox, calendar, collaboration layer, documents, goals, and operating preferences.",
    trust: "Can orchestrate work across the Level 3 agent system and executive context under explicit delegation rules.",
    capability: "Briefs the executive, triages signals, drafts responses, assigns agents, tracks follow-through, and runs approved workstreams.",
    controls: "Delegation contract, approval rules, pause access, inspect trace, revise authority.",
    implementation: "Use frontier lab LLM models to power the executive CoS; add executive context policy, approved access, heartbeat, orchestration, and exception handling on top of Level 3.",
    time: "6-12 weeks",
    needs: ["Delegation contract", "Tokens", "Approved access", "Agent team"],
    outcomes: ["Everything from Level 3", "Approved executive context and access", "Executive CoS heartbeat and delegation"],
    graphic: {
      leftTitle: "Level 3 foundation",
      left: [
        { label: "Agent OS", icon: Workflow },
        { label: "Agents", icon: Bot },
        { label: "Approvals + trace", icon: ClipboardList },
      ],
      center: { label: "Chief of Staff", icon: Bot },
      centerAddon: { label: "Executive context + access", icon: KeyRound },
      rightTitle: "Orchestrated work",
      right: [
        { label: "Brief", icon: ClipboardList },
        { label: "Delegate", icon: Users },
        { label: "Follow through", icon: CheckCircle2 },
      ],
    },
  },
];

const inboxScenarios = ["Scoped Read-Only Inbox", "Draft-Only Executive Inbox"];

const leverageOutcomes = [
  {
    value: "Sharper prep",
    label: "Meeting context, risks, open questions, and decisions arrive before the room starts.",
  },
  {
    value: "Follow-through",
    label: "Decisions turn into owners, drafts, reminders, and visible next steps.",
  },
  {
    value: "Shots on goal",
    label: "Leadership sees more qualified opportunities without adding full-time admin load.",
  },
];

const frameLoopSteps = [
  {
    title: "Approved context",
    label: "Inbox, docs, calendar, decisions, preferences.",
    icon: Database,
  },
  {
    title: "Chief of Staff agent",
    label: "Briefs, drafts, delegates, tracks, and escalates.",
    icon: Bot,
  },
  {
    title: "Visible operating work",
    label: "Prepared meetings, owner lists, RFP motion, and trace.",
    icon: ClipboardList,
  },
];

const frameWorkReturns = [
  { title: "Meeting briefs", label: "Prepared from approved decisions, people, risks, and open questions.", icon: FileText },
  { title: "Signal triage", label: "Important asks and deadlines surfaced from live collaboration threads.", icon: Inbox },
  { title: "Drafted follow-up", label: "Replies, recaps, reminders, and next-step tasks ready for review.", icon: MessageSquare },
  { title: "Opportunity motion", label: "RFPs and business development actions moved toward qualified submissions.", icon: BriefcaseBusiness },
];

const coverPillars = [
  { value: "30 days", label: "Evidence pilot, not broad production rollout.", icon: ClipboardList },
  { value: "L1 first", label: "Start with one shared gateway conversation.", icon: Network },
  { value: "0 sends", label: "No autonomous inbox sends during the pilot.", icon: KeyRound },
];

const hookMetrics = [
  {
    value: "30 days",
    title: "Controlled pilot",
    label: "Enough time to prove value without granting broad production access.",
    icon: ClipboardList,
  },
  {
    value: "2 leaders",
    title: "Focused first users",
    label: "CBO and sales lead workflows give the pilot clear executive and growth value.",
    icon: Users,
  },
  {
    value: "10+",
    title: "Useful artifacts",
    label: "Meeting briefs, follow-up lists, opportunity snapshots, and pilot charters.",
    icon: FileText,
  },
  {
    value: "100%",
    title: "Trace coverage",
    label: "Every source, action, approval, and handoff should be inspectable.",
    icon: CheckCircle2,
  },
];

const hookScorecard = [
  "Personal AI use is already happening, but it does not create shared operating memory.",
  "The shared knowledge base is the gating asset: without it, the CoS has no company context.",
  "Governed delegation is the difference between useful agents and uncontrolled automation.",
];

const hookGuardrails = [
  "No executive inbox write access at the start.",
  "No hidden access expansion or unlogged agent actions.",
  "Move L1 to L3 without losing shared memory or artifacts.",
];

const navItems = [
  { id: "cover", label: "Cover" },
  { id: "hook", label: "Hook" },
  { id: "frame", label: "Frame" },
  { id: "level-0", label: "L0" },
  { id: "level-1", label: "L1" },
  { id: "level-2", label: "L2" },
  { id: "level-3", label: "L3" },
  { id: "level-4", label: "L4" },
  { id: "summary", label: "Summary" },
];

function SlideFrame({
  id,
  eyebrow,
  title,
  subtitle,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="min-h-screen scroll-mt-6 border-b border-border bg-background px-6 py-10 md:px-10 lg:px-14"
    >
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-7xl flex-col gap-8">
        <div className="max-w-4xl">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {eyebrow}
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground md:text-5xl">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground md:text-lg">
              {subtitle}
            </p>
          ) : null}
        </div>
        <div className="flex-1">{children}</div>
      </div>
    </section>
  );
}

function CoverSlide() {
  return (
    <section
      id="cover"
      className="min-h-screen scroll-mt-6 border-b border-border bg-background px-6 py-10 md:px-10 lg:px-14"
    >
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-7xl items-center gap-8 lg:grid-cols-[1.08fr_0.92fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Executive CoS pilot
          </p>
          <h1 className="mt-3 max-w-4xl text-4xl font-bold tracking-tight text-foreground md:text-6xl">
            Chief of Staff Agent Readiness
          </h1>
          <p className="mt-5 max-w-3xl text-lg leading-8 text-muted-foreground">
            A controlled path from shared conversation to governed executive support,
            built around trust, traceability, and useful work.
          </p>

          <div className="mt-8 flex flex-wrap gap-2">
            <Badge variant="secondary">MKThink leadership pilot</Badge>
            <Badge variant="outline">Context + Trust = Capability</Badge>
            <Badge variant="outline">Human-approved access</Badge>
          </div>

          <div className="mt-10 grid gap-3 sm:grid-cols-3">
            {coverPillars.map((pillar) => {
              const Icon = pillar.icon;

              return (
                <div key={pillar.value} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-muted">
                    <Icon className="h-4 w-4 text-foreground" aria-hidden />
                  </div>
                  <p className="mt-5 text-2xl font-bold text-foreground">{pillar.value}</p>
                  <p className="mt-2 text-sm leading-5 text-muted-foreground">{pillar.label}</p>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-3">
            <Sparkles className="h-5 w-5 text-foreground" aria-hidden />
            <p className="text-sm font-semibold text-foreground">The buyer question</p>
          </div>
          <p className="mt-5 text-3xl font-bold leading-tight text-foreground">
            How much context is useful enough to earn the next level of trust?
          </p>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            The pilot should not ask leaders to hand over everything. It should
            prove that each added level of context creates visible, inspectable work.
          </p>

          <div className="mt-8 grid gap-3">
            {[
              { title: "Context", label: "Shared threads, approved sources, and executive preferences." },
              { title: "Trust", label: "Delegation contracts, approval gates, and trace evidence." },
              { title: "Capability", label: "Useful artifacts, business outcomes, and governed execution." },
            ].map((item) => (
              <div key={item.title} className="rounded-md border border-border bg-muted/40 p-4">
                <p className="text-sm font-semibold text-foreground">{item.title}</p>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function HookMetricsSlide() {
  return (
    <section
      id="hook"
      className="min-h-screen scroll-mt-6 border-b border-border bg-background px-6 py-8 md:px-10 lg:px-14"
    >
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-7xl flex-col gap-5">
        <div className="max-w-5xl">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Market hook
          </p>
          <h1 className="mt-2 max-w-5xl text-3xl font-bold tracking-tight text-foreground md:text-5xl">
            Every company is onboarding AI agents. Not everyone is doing it right.
          </h1>
          <p className="mt-3 max-w-4xl text-base leading-7 text-muted-foreground">
            The risk is not trying agents. The risk is adding agents without shared
            context, permission boundaries, useful artifacts, and a trace leadership
            can inspect.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {hookMetrics.map((metric) => {
            const Icon = metric.icon;

            return (
              <div key={metric.title} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-2xl font-bold text-foreground">{metric.value}</p>
                    <p className="mt-1 text-sm font-semibold text-foreground">{metric.title}</p>
                  </div>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                    <Icon className="h-4 w-4 text-foreground" aria-hidden />
                  </div>
                </div>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{metric.label}</p>
              </div>
            );
          })}
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              <BriefcaseBusiness className="h-5 w-5 text-foreground" aria-hidden />
              <h2 className="text-lg font-semibold text-foreground">What this means for MKThink</h2>
            </div>
            <div className="mt-3 grid gap-2">
              {hookScorecard.map((item) => (
                <div key={item} className="flex gap-3 rounded-md bg-muted/50 p-3 text-sm leading-5 text-muted-foreground">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-foreground" aria-hidden />
                  {item}
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              AgentDash and Paperclip should make this progression visible: start
              shared, add approved knowledge, then add governed execution.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              <KeyRound className="h-5 w-5 text-foreground" aria-hidden />
              <h2 className="text-lg font-semibold text-foreground">Access guardrails</h2>
            </div>
            <div className="mt-3 grid gap-2">
              {hookGuardrails.map((item) => (
                <div key={item} className="rounded-md border border-border bg-muted/40 p-3 text-sm leading-5 text-muted-foreground">
                  {item}
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-md border border-border bg-background p-3">
              <p className="text-2xl font-bold text-foreground">0</p>
              <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Unapproved sends
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function LevelBadge({ value }: { value: string }) {
  return (
    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-sm font-semibold text-foreground">
      L{value}
    </span>
  );
}

function GraphicNode({
  icon: Icon,
  label,
  compact = false,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-md border border-border bg-card px-3 ${
        compact ? "py-2" : "py-3"
      }`}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="h-4 w-4 text-foreground" aria-hidden />
      </div>
      <span className="text-sm font-medium text-foreground">{label}</span>
    </div>
  );
}

function LevelGraphic({ level }: { level: (typeof levels)[number] }) {
  const CenterIcon = level.graphic.center.icon;
  const centerAddon =
    "centerAddon" in level.graphic && level.graphic.centerAddon
      ? level.graphic.centerAddon
      : null;
  const centerItems =
    "centerItems" in level.graphic && Array.isArray(level.graphic.centerItems)
      ? level.graphic.centerItems
      : [];
  const CenterAddonIcon = centerAddon?.icon;
  const compactRight = level.level === "4";

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-5">
      <div className="grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1.1fr_auto_1fr]">
        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {level.graphic.leftTitle}
          </p>
          <div className="space-y-3">
            {level.graphic.left.map((node) => (
              <GraphicNode key={node.label} icon={node.icon} label={node.label} />
            ))}
          </div>
        </div>

        <div className="hidden items-center justify-center lg:flex">
          <ArrowRight className="h-5 w-5 text-muted-foreground" aria-hidden />
        </div>

        <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-border bg-card p-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-md border border-border bg-muted">
            <CenterIcon className="h-8 w-8 text-foreground" aria-hidden />
          </div>
          <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Level {level.level}
          </p>
          <p className="mt-2 text-2xl font-bold text-foreground">{level.graphic.center.label}</p>
          {centerItems.length > 0 ? (
            <div className="mt-5 grid w-full gap-2">
              {centerItems.map((item) => {
                const ItemIcon = item.icon;

                return (
                  <div
                    key={item.label}
                    className="flex items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-left"
                  >
                    <ItemIcon className="h-4 w-4 shrink-0 text-foreground" aria-hidden />
                    <span className="text-xs font-medium text-foreground">{item.label}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
          {centerAddon && CenterAddonIcon ? (
            <div className="mt-5 w-full rounded-md border border-border bg-muted/60 p-4">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-md border border-border bg-card">
                <CenterAddonIcon className="h-5 w-5 text-foreground" aria-hidden />
              </div>
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Level {level.level} addition
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">{centerAddon.label}</p>
            </div>
          ) : null}
        </div>

        <div className="hidden items-center justify-center lg:flex">
          <ArrowRight className="h-5 w-5 text-muted-foreground" aria-hidden />
        </div>

        <div>
          <p
            className={`${
              compactRight ? "mb-2" : "mb-3"
            } text-xs font-medium uppercase tracking-wide text-muted-foreground`}
          >
            {level.graphic.rightTitle}
          </p>
          <div className={compactRight ? "space-y-2" : "space-y-3"}>
            {level.graphic.right.map((node) => (
              <GraphicNode
                key={node.label}
                icon={node.icon}
                label={node.label}
                compact={compactRight}
              />
            ))}
          </div>
          {level.level === "4" ? (
            <div className="mt-3 rounded-md border border-border bg-card p-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Inbox className="h-4 w-4 text-foreground" aria-hidden />
                </div>
                <div>
                  <p className="text-xs font-semibold text-foreground">Level 4 inbox access</p>
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    Observe first, draft later.
                  </p>
                </div>
              </div>
              <div className="mt-3 grid gap-2">
                {inboxScenarios.map((scenario) => (
                  <div key={scenario} className="text-xs text-muted-foreground">
                    {scenario}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function LevelStorySlide({ level }: { level: (typeof levels)[number] }) {
  return (
    <SlideFrame
      id={`level-${level.level}`}
      eyebrow={`Level ${level.level}`}
      title={level.name}
      subtitle={level.headline}
    >
      <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="space-y-5">
          <div className="rounded-lg border border-border bg-card p-6">
            <div className="flex items-center gap-3">
              <LevelBadge value={level.level} />
              <div>
                <p className="text-sm font-semibold text-foreground">Example</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{level.example}</p>
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-1">
            <div className="rounded-lg border border-border bg-card p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                What is needed
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {level.needs.map((item) => (
                  <Badge key={item} variant="outline">{item}</Badge>
                ))}
              </div>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">{level.implementation}</p>
            </div>

            <div className="rounded-lg border border-border bg-card p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                What unlocks
              </p>
              <div className="mt-3 grid gap-2">
                {level.outcomes.map((item) => (
                  <div key={item} className="flex gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-foreground" aria-hidden />
                    {item}
                  </div>
                ))}
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">Rough timeframe: {level.time}</p>
              {"footnote" in level && level.footnote ? (
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{level.footnote}</p>
              ) : null}
            </div>
          </div>
        </div>

        <LevelGraphic level={level} />
      </div>
    </SlideFrame>
  );
}

function SummaryProgression() {
  const summaryAdditions = [
    "Personal AI tools; no shared context or agent-to-agent communication.",
    "Multiple humans can work through one gateway agent.",
    "Level 1 plus approved company knowledge from shared repositories.",
    "Level 2 plus AgentDash or equivalent local/cloud agent operating system.",
    "Level 3 plus approved executive context, access, heartbeat, and delegation.",
  ];
  const summaryOptions = [
    {
      level: "1",
      title: "Start with a shared gateway",
      badge: "Start here",
      recommendation: "Give the leadership team one shared agent conversation before connecting broad company knowledge.",
      detail: "The prompts, decisions, and useful artifacts become reusable operating memory for the next level.",
    },
    {
      level: "2",
      title: "Add company knowledge",
      badge: "Then",
      recommendation: "Connect approved repositories to the same gateway so L1 work becomes source-grounded.",
      detail: "Shared conversations, source traces, and useful artifacts carry forward instead of being restarted.",
    },
    {
      level: "3",
      title: "Add governed execution",
      badge: "Then",
      recommendation: "Promote proven L2 workflows into goals, agents, approvals, traces, and deliverables.",
      detail: "The agent operating system inherits the shared memory and company context already built in L1 and L2.",
    },
    {
      level: "4",
      title: "Executive CoS rollout",
      badge: "Later",
      recommendation: "Defer until Level 3 has produced trust evidence and an executive sponsor opts in.",
      detail: "Adds approved executive context/access, heartbeat, and a delegation contract.",
    },
  ];

  return (
    <div className="grid gap-5">
      <div className="grid gap-3 lg:grid-cols-5">
        {levels.map((level) => (
          <div key={level.level} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <LevelBadge value={level.level} />
              <span className="text-xs font-medium text-muted-foreground">{level.time}</span>
            </div>
            <p className="mt-4 text-sm font-semibold text-foreground">{level.name}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {summaryAdditions[Number(level.level)]}
            </p>
          </div>
        ))}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        All timeframe estimates depend on how quickly the shared knowledge base can be created,
        approved, and kept current.
      </p>
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Where to start</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Start at L1, then compound the same work and memory into L2 and L3.
            </p>
          </div>
          <Badge variant="secondary">L1 to L2 to L3 without restart</Badge>
        </div>
        <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
          {summaryOptions.slice(0, 3).map((option, index) => (
            <Fragment key={option.level}>
              {index > 0 ? (
                <div className="hidden items-center justify-center lg:flex">
                  <ArrowRight className="h-5 w-5 text-muted-foreground" aria-hidden />
                </div>
              ) : null}
              <div className="rounded-md border border-border bg-muted/40 p-4">
                <div className="flex items-center justify-between gap-3">
                  <LevelBadge value={option.level} />
                  <Badge variant="outline">{option.badge}</Badge>
                </div>
                <p className="mt-4 text-sm font-semibold text-foreground">{option.title}</p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {option.recommendation}
                </p>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{option.detail}</p>
              </div>
            </Fragment>
          ))}
        </div>
        <div className="mt-3 rounded-md border border-border bg-background p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Memory carried forward
          </p>
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            {[
              "L1 shared threads and decisions",
              "L2 source traces and useful artifacts",
              "L3 goals, approvals, and execution history",
            ].map((item) => (
              <div key={item} className="flex gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-foreground" aria-hidden />
                {item}
              </div>
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Each step preserves the prior work, so the shared memory gets stronger instead of being rebuilt.
        </p>
        <div className="mt-5 grid gap-3 lg:grid-cols-1">
          {summaryOptions.map((option) =>
            option.level === "4" ? (
              <div
                key={option.level}
                className="rounded-md border border-border bg-muted/40 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <LevelBadge value={option.level} />
                  <Badge variant="outline">{option.badge}</Badge>
                </div>
                <p className="mt-4 text-sm font-semibold text-foreground">{option.title}</p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {option.recommendation}
                </p>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  {option.detail}
                </p>
              </div>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}

export function CoSPilotTrustDeck() {
  const deckRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const scrollToHash = () => {
      const id = window.location.hash.slice(1);

      if (!id) {
        return;
      }

      const target = document.getElementById(id);
      const deck = deckRef.current;

      if (!target || !deck) {
        return;
      }

      const top = Math.max(target.offsetTop - 48, 0);
      deck.scrollTop = top;
    };

    scrollToHash();
    window.addEventListener("hashchange", scrollToHash);

    return () => window.removeEventListener("hashchange", scrollToHash);
  }, []);

  return (
    <main
      ref={deckRef}
      className="h-screen overflow-y-auto bg-surface-page text-text-primary"
      style={lightDeckTheme}
    >
      <div className="sticky top-0 z-20 border-b border-border bg-surface-page/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted">
              <Bot className="h-4 w-4" aria-hidden />
            </div>
            <div>
              <p className="text-sm font-semibold">CoS Pilot Deck</p>
              <p className="text-xs text-muted-foreground">Context + Trust = Capability</p>
            </div>
          </div>
          <nav className="hidden items-center gap-2 md:flex">
            {navItems.map((item) => (
              <Button key={item.id} variant="ghost" size="sm" asChild>
                <a href={`#${item.id}`}>{item.label}</a>
              </Button>
            ))}
          </nav>
        </div>
      </div>

      <CoverSlide />
      <HookMetricsSlide />

      <SlideFrame
        id="frame"
        eyebrow="Executive CoS pilot"
        title="How useful should a Chief of Staff agent be allowed to become?"
        subtitle="A real Chief of Staff should make leadership sharper: better prepared, less reactive, and more consistent about follow-through."
      >
        <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="rounded-lg border border-border bg-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-3">
                  <Sparkles className="h-5 w-5 text-foreground" aria-hidden />
                  <h2 className="text-lg font-semibold">The executive operating loop</h2>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  The CoS is valuable when trusted context turns into visible work,
                  not just better chat responses.
                </p>
              </div>
              <Badge variant="secondary">Human-approved access</Badge>
            </div>

            <div className="mt-8 grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
              {frameLoopSteps.map((step, index) => {
                const Icon = step.icon;

                return (
                  <Fragment key={step.title}>
                    <div className="flex flex-col justify-between rounded-md bg-muted/60 p-5">
                      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-card">
                        <Icon className="h-5 w-5 text-foreground" aria-hidden />
                      </div>
                      <div className="mt-6">
                        <p className="text-sm font-semibold text-foreground">{step.title}</p>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">{step.label}</p>
                      </div>
                    </div>
                    {index < frameLoopSteps.length - 1 ? (
                      <div className="hidden items-center justify-center lg:flex">
                        <ArrowRight className="h-5 w-5 text-muted-foreground" aria-hidden />
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-3">
              {leverageOutcomes.map((target) => (
                <div key={target.value} className="rounded-md border border-border bg-background p-4">
                  <p className="text-lg font-bold text-foreground">{target.value}</p>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{target.label}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-6">
            <div className="flex items-center gap-3">
              <TrendingUp className="h-5 w-5 text-foreground" aria-hidden />
              <h2 className="text-lg font-semibold text-foreground">What the Chief of Staff gives back</h2>
            </div>
            <div className="mt-5 grid gap-3">
              {frameWorkReturns.map((item) => {
                const Icon = item.icon;

                return (
                  <div key={item.title} className="flex gap-3 rounded-md bg-muted/50 p-4">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-card">
                      <Icon className="h-4 w-4 text-foreground" aria-hidden />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{item.title}</p>
                      <p className="mt-1 text-sm leading-5 text-muted-foreground">{item.label}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </SlideFrame>

      {levels.map((level) => (
        <LevelStorySlide key={level.level} level={level} />
      ))}

      <SlideFrame
        id="summary"
        eyebrow="Summary"
        title="A simple maturity path"
        subtitle="The details live in the individual level slides. This is the buyer-facing map."
      >
        <SummaryProgression />
      </SlideFrame>
    </main>
  );
}
