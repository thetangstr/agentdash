// AgentDash — PUBLIC investor + partner brief (Google for Startups application,
// investor outreach). No auth, no sidebar, no company context. Mounted OUTSIDE
// CloudAccessGate in ui/src/App.tsx at /investors, the same public tier as
// /trial and /share/:shareToken. The app shell sets `body { overflow: hidden }`,
// so this full-screen page owns its OWN scroll region (`h-screen overflow-y-auto`),
// exactly like TrialLanding.
//
// Design: the "Porcelain" system — clay accent (var(--accent-500)), Manrope,
// hairline borders, generous radii, near-zero shadows, scroll-reveal motion that
// no-ops under prefers-reduced-motion. Mirrors Overview.tsx / TrialLanding.tsx.
//
// ⚠️ PLACEHOLDERS YOU MUST FILL IN BEFORE SENDING ⚠️
// Every data point below that could be fabricated is rendered as an OBVIOUS
// dashed "PLACEHOLDER" card, never as an invented number. Find them by searching
// this file for `data-placeholder=` or the <PlaceholderCard> component. The full
// list (also surfaced visually on the page):
//
//   TRACTION  (data-placeholder="traction-*")
//     • traction-signups   — signups / active users / waitlist
//     • traction-usage     — usage (agents run, tasks completed, deliverables)
//     • traction-revenue   — revenue / MRR / ARR / trial conversions
//     • traction-pipeline  — pipeline / design partners / LOIs
//     • traction-proof     — (optional) customer logo strip or operator quote
//   TEAM  (data-placeholder="team-*")
//     • team-member-1 / team-member-2 / team-member-3 — name, role, one-line bio
//     • team-advisors      — (optional) advisors / backers
//   THE ASK  (data-placeholder="ask-*")
//     • ask-stage          — round stage (pre-seed / seed / …)
//     • ask-amount         — amount you're raising
//     • ask-use            — use of funds
//   CONTACT  (data-placeholder="contact-*")
//     • contact-email      — outreach email
//     • contact-deck       — (optional) deck / data-room link
//
// Everything NOT in a PlaceholderCard (vision, problem, product, market, moat)
// is defensible narrative drawn from the product + launch/loop strategy docs.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Sparkles,
  Bot,
  BrainCircuit,
  Repeat,
  ShieldCheck,
  Network,
  Gauge,
  Building2,
  Workflow,
  LineChart,
  Server,
  Users,
  Layers,
  Plug,
  Rocket,
  type LucideIcon,
} from "lucide-react";

const EASE = "cubic-bezier(0.22,1,0.36,1)";
const CLAY = "var(--accent-500)";

// ---------------------------------------------------------------------------
// motion
// ---------------------------------------------------------------------------

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

// Fade-in + rise the first time the block scrolls into view. Steady state is
// driven by React state (not CSS fill-mode) so it can never stall hidden. Same
// visual language as Overview/TrialLanding's Reveal, upgraded to Intersection
// Observer because this is a long scrolling page.
function Reveal({
  reduced,
  children,
  delay = 0,
  className,
  style,
  as: Tag = "div",
}: {
  reduced: boolean;
  children: ReactNode;
  delay?: number;
  className?: string;
  style?: CSSProperties;
  as?: "div" | "section" | "li";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(reduced);

  useEffect(() => {
    if (reduced) {
      setShown(true);
      return;
    }
    const node = ref.current;
    if (!node) {
      setShown(true);
      return;
    }

    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      window.setTimeout(() => setShown(true), delay);
    };

    // Reveal immediately if the element is already within (or near) the viewport
    // on mount — above-the-fold content must never depend on a scroll event.
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (node.getBoundingClientRect().top < vh * 0.95) {
      reveal();
    }

    // Observe for the scroll-reveal choreography where it works.
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              reveal();
              io?.disconnect();
              break;
            }
          }
        },
        { rootMargin: "0px 0px -10% 0px", threshold: 0.08 },
      );
      io.observe(node);
    }

    // Safety net: this page owns a nested `overflow-y-auto` scroll region, where
    // a viewport-rooted observer can fail to report intersections — never leave
    // content stranded at opacity 0 if the observer never fires.
    const fallback = window.setTimeout(() => reveal(), 700 + delay);

    return () => {
      io?.disconnect();
      window.clearTimeout(fallback);
    };
  }, [reduced, delay]);

  return (
    <Tag
      ref={ref as React.Ref<never>}
      className={className}
      style={{
        ...style,
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(16px)",
        transition: reduced ? undefined : `opacity 560ms ${EASE}, transform 560ms ${EASE}`,
        willChange: reduced ? undefined : "opacity, transform",
      }}
    >
      {children}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="flex items-center justify-center rounded-lg text-white"
        style={{ width: 26, height: 26, background: CLAY, flex: "none" }}
      >
        <Sparkles style={{ width: 14, height: 14 }} />
      </span>
      <span className="text-[15px] font-extrabold tracking-[-0.03em] text-foreground">
        AgentDash
      </span>
    </span>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 800,
        textTransform: "uppercase",
        letterSpacing: "0.14em",
        color: CLAY,
      }}
    >
      {children}
    </div>
  );
}

function SectionShell({
  id,
  reduced,
  eyebrow,
  title,
  lede,
  children,
  tinted,
}: {
  id: string;
  reduced: boolean;
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  tinted?: boolean;
}) {
  return (
    <section
      id={id}
      className={tinted ? "bg-secondary/40" : undefined}
      style={{ borderTop: "1px solid var(--border)", scrollMarginTop: 72 }}
    >
      <div className="mx-auto w-full max-w-[1080px] px-6 sm:px-7" style={{ padding: "72px 24px 80px" }}>
        <Reveal reduced={reduced}>
          <Eyebrow>{eyebrow}</Eyebrow>
          <h2
            className="text-foreground"
            style={{
              fontSize: 30,
              fontWeight: 800,
              letterSpacing: "-0.035em",
              lineHeight: 1.08,
              marginTop: 14,
              maxWidth: 760,
            }}
          >
            {title}
          </h2>
          {lede ? (
            <p
              className="text-muted-foreground"
              style={{ fontSize: 16.5, lineHeight: 1.6, marginTop: 16, maxWidth: 720 }}
            >
              {lede}
            </p>
          ) : null}
        </Reveal>
        {children}
      </div>
    </section>
  );
}

// A standard, defensible "feature/point" card.
function PointCard({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl h-full" style={{ padding: 20 }}>
      <div
        className="bg-secondary"
        style={{
          width: 40,
          height: 40,
          borderRadius: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={19} className="text-foreground" />
      </div>
      <div className="text-foreground" style={{ fontSize: 15.5, fontWeight: 700, marginTop: 14 }}>
        {title}
      </div>
      <p className="text-muted-foreground" style={{ fontSize: 13.5, lineHeight: 1.5, marginTop: 7 }}>
        {body}
      </p>
    </div>
  );
}

// The OBVIOUS, consistently-styled empty slot the user must replace before
// sending the page out. Dashed clay border + a loud "PLACEHOLDER" tag so it can
// never be mistaken for real, shipped content.
function PlaceholderCard({
  slot,
  label,
  hint,
  minHeight = 120,
}: {
  slot: string;
  label: string;
  hint: string;
  minHeight?: number;
}) {
  return (
    <div
      data-placeholder={slot}
      className="rounded-2xl h-full"
      style={{
        border: `2px dashed color-mix(in oklab, ${CLAY} 55%, transparent)`,
        background: `color-mix(in oklab, ${CLAY} 6%, var(--card))`,
        padding: 20,
        minHeight,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <span
        style={{
          alignSelf: "flex-start",
          fontSize: 9.5,
          fontWeight: 800,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          color: "#fff",
          background: CLAY,
          borderRadius: 999,
          padding: "3px 8px",
        }}
      >
        placeholder · fill in
      </span>
      <div className="text-foreground" style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>
        {label}
      </div>
      <p className="text-muted-foreground" style={{ fontSize: 13, lineHeight: 1.5 }}>
        {hint}
      </p>
      <code
        className="text-muted-foreground"
        style={{ fontSize: 11, marginTop: "auto", opacity: 0.8, fontFamily: "var(--font-mono)" }}
      >
        {slot}
      </code>
    </div>
  );
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export function InvestorsPage() {
  const reduced = usePrefersReducedMotion();

  return (
    <div className="h-screen overflow-y-auto bg-background text-foreground">
      {/* top bar */}
      <header
        className="sticky top-0 z-40 bg-background/85 backdrop-blur"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="mx-auto flex w-full max-w-[1080px] items-center justify-between px-6 sm:px-7" style={{ height: 60 }}>
          <a href="/investors" aria-label="AgentDash">
            <Wordmark />
          </a>
          <nav className="flex items-center gap-2.5">
            <a
              href="/auth"
              className="hidden rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-[var(--accent-500)] sm:inline-flex"
            >
              Sign in
            </a>
            <a
              href="/trial"
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-500)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              See it build a company
              <ArrowRight className="size-4" />
            </a>
          </nav>
        </div>
      </header>

      {/* ============================================================ HERO */}
      <section style={{ position: "relative", overflow: "hidden" }}>
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(60% 70% at 50% -10%, color-mix(in oklab, ${CLAY} 14%, transparent), transparent 70%)`,
            pointerEvents: "none",
          }}
        />
        <div
          className="mx-auto w-full max-w-[1080px] px-6 sm:px-7"
          style={{ padding: "80px 24px 76px", position: "relative" }}
        >
          <Reveal reduced={reduced}>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Sparkles className="size-3.5 text-[var(--accent-500)]" />
              Investor &amp; partner brief
            </span>
          </Reveal>

          <Reveal reduced={reduced} delay={80}>
            <h1
              className="text-foreground"
              style={{
                fontSize: 44,
                fontWeight: 800,
                letterSpacing: "-0.045em",
                lineHeight: 1.04,
                marginTop: 22,
                maxWidth: 920,
              }}
            >
              An AI Chief of Staff that designs, staffs, and runs an{" "}
              <span style={{ color: CLAY }}>autonomous company</span> — a team of
              agents that does real work, improves itself, and proves it.
            </h1>
          </Reveal>

          <Reveal reduced={reduced} delay={150}>
            <p
              className="text-muted-foreground"
              style={{ fontSize: 18, lineHeight: 1.6, marginTop: 22, maxWidth: 680 }}
            >
              Describe your business in a sentence. A Chief of Staff agent assembles
              a tailored team, puts them to work, and surfaces only the decisions
              that need you. Governed autonomy you can prove — with a dial from
              hands-on to hands-off.
            </p>
          </Reveal>

          <Reveal reduced={reduced} delay={220}>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a
                href="/trial"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-6 py-3.5 text-base font-semibold text-white transition-opacity hover:opacity-90"
              >
                <Rocket className="size-5" />
                See it build a company
              </a>
              <a
                href="/auth"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-card px-6 py-3.5 text-base font-medium text-foreground transition-colors hover:border-[var(--accent-500)]"
              >
                Sign in
              </a>
              <a
                href="#contact"
                className="inline-flex items-center justify-center gap-2 px-2 py-3.5 text-base font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Talk to us
                <ArrowRight className="size-4" />
              </a>
            </div>
          </Reveal>

          {/* the four-competency flywheel, stated plainly */}
          <Reveal reduced={reduced} delay={300}>
            <div className="mt-14 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { icon: Bot, h: "Runs itself", b: "An autonomous company that executes without anyone clicking go." },
                { icon: Gauge, h: "Dials to you", b: "Adjustable human involvement — as much or as little as you want." },
                { icon: Sparkles, h: "Onboards in minutes", b: "A Chief of Staff stands up the whole company through conversation." },
                { icon: Repeat, h: "Gets smarter", b: "Loops pick up signals and compound — the company improves over time." },
              ].map((c) => (
                <div key={c.h} className="bg-card border border-border rounded-2xl" style={{ padding: 16 }}>
                  <c.icon size={18} className="text-[var(--accent-500)]" />
                  <div className="text-foreground" style={{ fontSize: 14, fontWeight: 700, marginTop: 10 }}>
                    {c.h}
                  </div>
                  <p className="text-muted-foreground" style={{ fontSize: 12.5, lineHeight: 1.45, marginTop: 5 }}>
                    {c.b}
                  </p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ====================================================== PROBLEM / WHY NOW */}
      <SectionShell
        id="why-now"
        reduced={reduced}
        eyebrow="The problem · why now"
        title={<>Software made work faster. The next wave does the work.</>}
        lede={
          <>
            Every team is drowning in operational work that is too unstructured for
            rigid automation and too repetitive for skilled people. Chatbots answer
            questions; they do not own outcomes. 2026 is the year agents that
            actually <em>do</em> the work overtake horizontal SaaS — and the winning
            shape is a horizontal substrate with a vertical wedge, not a single
            point-solution bot.
          </>
        }
      >
        <div className="mt-12 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Reveal reduced={reduced} delay={0}>
            <PointCard
              icon={Workflow}
              title="Automation is too brittle"
              body="Zapier / n8n-style pipelines are deterministic. They break on anything novel and never improve — they cannot run a function, only a script."
            />
          </Reveal>
          <Reveal reduced={reduced} delay={70}>
            <PointCard
              icon={Bot}
              title="Single AI employees don't compound"
              body="One agent, one job, no shared org brain. You still steer each one by hand, and nothing one agent learns helps the next."
            />
          </Reveal>
          <Reveal reduced={reduced} delay={140}>
            <PointCard
              icon={ShieldCheck}
              title="Autonomy without trust is a non-starter"
              body="Operators won't hand real work to a black box. They need governance, an autonomy dial, and provable records of what ran."
            />
          </Reveal>
        </div>
      </SectionShell>

      {/* ====================================================== PRODUCT / HOW IT WORKS */}
      <SectionShell
        id="product"
        reduced={reduced}
        tinted
        eyebrow="Product · how it works"
        title={<>From one sentence to a working company.</>}
        lede="The same flow that powers our public test drive: tell the Chief of Staff what you do, and watch a real team assemble and start delivering."
      >
        <div className="mt-12 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: Sparkles,
              step: "01",
              h: "Describe your business",
              b: "A Chief of Staff agent asks two or three sharp questions — no forms, no setup.",
            },
            {
              icon: Building2,
              step: "02",
              h: "It designs the company",
              b: "The CoS sizes the problem, picks the right roles, and writes each agent's charter.",
            },
            {
              icon: Bot,
              step: "03",
              h: "The team goes to work",
              b: "A tailored fleet of agents assembles on a live board and each does a real first task.",
            },
            {
              icon: LineChart,
              step: "04",
              h: "You get deliverables",
              b: "Real artifacts land — outreach, reconciliations, drafts, research — with you approving what matters.",
            },
          ].map((s, i) => (
            <Reveal key={s.step} reduced={reduced} delay={i * 70}>
              <div className="bg-card border border-border rounded-2xl h-full" style={{ padding: 20 }}>
                <div className="flex items-center justify-between">
                  <div
                    className="bg-secondary"
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 14,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <s.icon size={19} className="text-foreground" />
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 800, color: CLAY, letterSpacing: "0.05em" }}>
                    {s.step}
                  </span>
                </div>
                <div className="text-foreground" style={{ fontSize: 15, fontWeight: 700, marginTop: 14 }}>
                  {s.h}
                </div>
                <p className="text-muted-foreground" style={{ fontSize: 13, lineHeight: 1.5, marginTop: 7 }}>
                  {s.b}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal reduced={reduced} delay={100}>
          <div
            className="bg-card border border-border rounded-2xl"
            style={{ marginTop: 28, padding: "20px 22px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Sparkles className="size-4 text-[var(--accent-500)]" />
              The proof is the product
            </span>
            <span className="text-sm text-muted-foreground" style={{ flex: 1, minWidth: 240 }}>
              Anyone can run this live, no signup and no card, in about a minute.
            </span>
            <a
              href="/trial"
              className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90"
            >
              Run the test drive
              <ArrowRight className="size-4" />
            </a>
          </div>
        </Reveal>
      </SectionShell>

      {/* ====================================================== MARKET & WEDGE */}
      <SectionShell
        id="market"
        reduced={reduced}
        eyebrow="Market &amp; wedge"
        title={<>One horizontal platform. A sharp vertical wedge.</>}
        lede={
          <>
            AgentDash is a single horizontal substrate — a CoS-led, multi-human
            workspace. Verticals are starter templates and go-to-market wedges, not
            forked codebases. Our beachhead is managed-service and agency operations,
            where the shape of the work fits agents and the pain is acute.
          </>
        }
      >
        <div className="mt-12 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Reveal reduced={reduced} delay={0}>
            <PointCard
              icon={Layers}
              title="Horizontal substrate, vertical wedge"
              body="Land one painful workflow — e.g. tier-1 ticket triage for MSPs — then expand across the function. The platform stays horizontal; the GTM stays focused."
            />
          </Reveal>
          <Reveal reduced={reduced} delay={70}>
            <PointCard
              icon={Server}
              title="Two SKUs, one product"
              body="Lead with cloud-managed for speed to value; offer on-prem / bring-your-own deployment as the enterprise unlock, where data residency is the #1 driver."
            />
          </Reveal>
          <Reveal reduced={reduced} delay={140}>
            <PointCard
              icon={LineChart}
              title="Hybrid pricing → outcome-based"
              body="Start with a per-seat base plus usage-based inference pass-through, then evolve toward per-outcome pricing as the loop measures the outcomes it produces."
            />
          </Reveal>
        </div>
        <Reveal reduced={reduced} delay={120}>
          <p className="text-muted-foreground" style={{ fontSize: 13.5, lineHeight: 1.6, marginTop: 22, maxWidth: 760 }}>
            Strategy, framed as plan rather than result: the pricing evolution and SKU
            mix are our roadmap, validated against current market direction — not
            achieved metrics. See traction below for what we have today.
          </p>
        </Reveal>
      </SectionShell>

      {/* ====================================================== DIFFERENTIATION / MOAT */}
      <SectionShell
        id="moat"
        reduced={reduced}
        tinted
        eyebrow="Differentiation · the moat"
        title={<>The loop is the moat — and it compounds.</>}
        lede={
          <>
            No incumbent integrates governed multi-agent execution, compounding
            shared memory, provable autonomy, agent-led onboarding, and an autonomy
            dial as one product. Single features are copyable; the coherent flywheel
            is not.
          </>
        }
      >
        <div className="mt-12 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Reveal reduced={reduced} delay={0}>
            <PointCard
              icon={Repeat}
              title="Loop = heartbeat (engine) + brain"
              body="The heartbeat is the production-grade engine: triggers plus governed execution. The loop adds the brain on top — shared memory and what-to-do-next — without rebuilding the hard part."
            />
          </Reveal>
          <Reveal reduced={reduced} delay={70}>
            <PointCard
              icon={BrainCircuit}
              title="An accruing company brain"
              body="Every loop reads and writes a shared, company-scoped signal substrate. The longer a company runs, the richer its brain and the smarter its CoS — a data and switching-cost moat single-agent tools structurally can't build."
            />
          </Reveal>
          <Reveal reduced={reduced} delay={140}>
            <PointCard
              icon={Users}
              title="Multi-human + CoS substrate"
              body="A real workspace where multiple people and many agents collaborate, summoned by @-mention, coordinated by the Chief of Staff — not a single-player bot."
            />
          </Reveal>
          <Reveal reduced={reduced} delay={210}>
            <PointCard
              icon={ShieldCheck}
              title="Governed autonomy you can prove"
              body="Approval gates are the dial; the CoS escalates only when it matters; autonomous actions can be cryptographically attested. Minimal-human stays safe and auditable."
            />
          </Reveal>
        </div>

        <Reveal reduced={reduced} delay={120}>
          <div className="bg-card border border-border rounded-2xl" style={{ marginTop: 16, padding: 20 }}>
            <div className="flex items-center gap-3">
              <span
                className="bg-secondary"
                style={{ width: 40, height: 40, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}
              >
                <Network size={19} className="text-foreground" />
              </span>
              <div className="text-foreground" style={{ fontSize: 15.5, fontWeight: 700 }}>
                Runtime independence
              </div>
              <Plug size={16} className="ml-auto text-[var(--accent-500)]" />
            </div>
            <p className="text-muted-foreground" style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 12, maxWidth: 820 }}>
              We own the loop and we own model access. A managed inference gateway
              removes customer token wrangling, and a first-party native adapter
              removes the external-binary dependency — so the default agent runs
              reliably with zero setup, on cloud or on-prem. Third-party harnesses
              stay opt-in. That independence is what makes the autonomy promise
              dependable at launch.
            </p>
          </div>
        </Reveal>
      </SectionShell>

      {/* ====================================================== TRACTION (placeholders) */}
      <SectionShell
        id="traction"
        reduced={reduced}
        eyebrow="Traction"
        title={<>Where we are today.</>}
        lede="These cards are intentionally empty. Drop in your real numbers before sending — never invented ones."
      >
        <div className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Reveal reduced={reduced} delay={0}>
            <PlaceholderCard
              slot="traction-signups"
              label="Signups / active users"
              hint="e.g. total signups, weekly actives, or waitlist size with a growth rate."
            />
          </Reveal>
          <Reveal reduced={reduced} delay={60}>
            <PlaceholderCard
              slot="traction-usage"
              label="Usage"
              hint="e.g. agents run, tasks completed, or deliverables produced per week."
            />
          </Reveal>
          <Reveal reduced={reduced} delay={120}>
            <PlaceholderCard
              slot="traction-revenue"
              label="Revenue"
              hint="e.g. MRR / ARR, paying accounts, or Free→Pro trial conversions."
            />
          </Reveal>
          <Reveal reduced={reduced} delay={180}>
            <PlaceholderCard
              slot="traction-pipeline"
              label="Pipeline"
              hint="e.g. design partners, LOIs, or qualified opportunities in flight."
            />
          </Reveal>
        </div>
        <Reveal reduced={reduced} delay={120}>
          <div style={{ marginTop: 14 }}>
            <PlaceholderCard
              slot="traction-proof"
              label="Proof (optional)"
              hint="A customer logo strip, a design-partner quote, or a milestone timeline. Leave out entirely if you don't have it yet — do not fabricate."
              minHeight={96}
            />
          </div>
        </Reveal>
      </SectionShell>

      {/* ====================================================== TEAM (placeholders) */}
      <SectionShell
        id="team"
        reduced={reduced}
        tinted
        eyebrow="Team"
        title={<>Who's building it.</>}
        lede="Add each founder / team member below — name, role, and a one-line bio. Replace before sending."
      >
        <div className="mt-12 grid grid-cols-1 gap-3 md:grid-cols-3">
          {["team-member-1", "team-member-2", "team-member-3"].map((slot, i) => (
            <Reveal key={slot} reduced={reduced} delay={i * 70}>
              <PlaceholderCard
                slot={slot}
                label={`Team member ${i + 1}`}
                hint="Name · role · one line on the relevant experience that makes them the right person for this."
                minHeight={150}
              />
            </Reveal>
          ))}
        </div>
        <Reveal reduced={reduced} delay={120}>
          <div style={{ marginTop: 14 }}>
            <PlaceholderCard
              slot="team-advisors"
              label="Advisors / backers (optional)"
              hint="Notable advisors, angels, or existing investors — only if real and you have permission to list them."
              minHeight={96}
            />
          </div>
        </Reveal>
      </SectionShell>

      {/* ====================================================== THE ASK (placeholders) */}
      <SectionShell
        id="ask"
        reduced={reduced}
        eyebrow="The ask"
        title={<>What we're raising — and why now.</>}
        lede="Fill in the round details. These drive investor conversations, so they must be your real numbers."
      >
        <div className="mt-12 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Reveal reduced={reduced} delay={0}>
            <PlaceholderCard
              slot="ask-stage"
              label="Stage"
              hint="e.g. pre-seed / seed / bridge — and current status (raising / first close)."
              minHeight={140}
            />
          </Reveal>
          <Reveal reduced={reduced} delay={70}>
            <PlaceholderCard
              slot="ask-amount"
              label="Amount"
              hint="Target raise (and instrument — SAFE / priced), plus any committed."
              minHeight={140}
            />
          </Reveal>
          <Reveal reduced={reduced} delay={140}>
            <PlaceholderCard
              slot="ask-use"
              label="Use of funds"
              hint="How the capital converts to milestones — e.g. runtime, GTM hires, design partners."
              minHeight={140}
            />
          </Reveal>
        </div>
      </SectionShell>

      {/* ====================================================== GOOGLE FOR STARTUPS + CONTACT */}
      <section id="contact" style={{ borderTop: "1px solid var(--border)", scrollMarginTop: 72 }}>
        <div className="mx-auto w-full max-w-[1080px] px-6 sm:px-7" style={{ padding: "76px 24px 84px" }}>
          <Reveal reduced={reduced}>
            <div
              className="bg-card border border-border rounded-2xl"
              style={{ padding: "40px 32px", position: "relative", overflow: "hidden" }}
            >
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  inset: 0,
                  background: `radial-gradient(70% 120% at 100% 0%, color-mix(in oklab, ${CLAY} 12%, transparent), transparent 60%)`,
                  pointerEvents: "none",
                }}
              />
              <div style={{ position: "relative" }}>
                <Eyebrow>Google for Startups</Eyebrow>
                <h2
                  className="text-foreground"
                  style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.035em", lineHeight: 1.1, marginTop: 14, maxWidth: 760 }}
                >
                  A horizontal AI-agent platform, built to scale on cloud.
                </h2>
                <p className="text-muted-foreground" style={{ fontSize: 16, lineHeight: 1.6, marginTop: 14, maxWidth: 720 }}>
                  AgentDash is a cloud-native, multi-tenant platform that turns model
                  capability into governed, compounding work. We are applying to
                  Google for Startups to accelerate the managed runtime, scale the
                  cloud SKU, and bring provable autonomy to more teams. The product
                  is live and runnable today — start with the test drive.
                </p>

                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <a
                    href="/trial"
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-6 py-3.5 text-base font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    <Rocket className="size-5" />
                    See it build a company
                  </a>
                  <a
                    href="/auth"
                    className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-card px-6 py-3.5 text-base font-medium text-foreground transition-colors hover:border-[var(--accent-500)]"
                  >
                    Sign in
                  </a>
                </div>

                <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <PlaceholderCard
                    slot="contact-email"
                    label="Contact email"
                    hint="Where investors and the program should reach you. Replace with a real address."
                    minHeight={96}
                  />
                  <PlaceholderCard
                    slot="contact-deck"
                    label="Deck / data room (optional)"
                    hint="Link to your pitch deck or data room, if you want it on this page."
                    minHeight={96}
                  />
                </div>
              </div>
            </div>
          </Reveal>

          {/* footer */}
          <div
            className="mt-12 flex flex-wrap items-center justify-between gap-4"
            style={{ borderTop: "1px solid var(--border)", paddingTop: 24 }}
          >
            <Wordmark />
            <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
              <a href="/trial" className="transition-colors hover:text-foreground">Test drive</a>
              <a href="/pricing" className="transition-colors hover:text-foreground">Pricing</a>
              <a href="/" className="transition-colors hover:text-foreground">Home</a>
              <a href="/about" className="transition-colors hover:text-foreground">About</a>
              <a href="/auth" className="transition-colors hover:text-foreground">Sign in</a>
            </nav>
          </div>
        </div>
      </section>
    </div>
  );
}

export default InvestorsPage;
