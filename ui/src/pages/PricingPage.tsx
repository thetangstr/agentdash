// AgentDash — PUBLIC pricing page (Free / Pro / Team). No auth, no sidebar, no
// company context. Mounted OUTSIDE CloudAccessGate in ui/src/App.tsx at /pricing,
// the same public tier as /trial, /investors, and /share/:shareToken. The app
// shell sets `body { overflow: hidden }`, so this full-screen page owns its OWN
// scroll region (`h-screen overflow-y-auto`), exactly like InvestorsPage and
// TrialLanding.
//
// Design: the "Porcelain" system — clay accent (var(--accent-500)), Manrope,
// hairline borders, generous radii (rounded-2xl), near-zero shadows, and the
// reveal-on-mount-with-fallback motion that no-ops under prefers-reduced-motion.
// Mirrors InvestorsPage.tsx / TrialLanding.tsx exactly so the public marketing
// surface stays one coherent brand.
//
// Tiers + numbers below come from the Subscription + Billing sub-project (Free:
// 1 human + 1 agent, 50 runs/mo; Pro: $29/seat, unlimited, 1,000 runs/mo +250
// per seat then $0.05/run overage, 14-day no-card trial; Team: custom). Every
// CTA routes to sign-up (`/auth?mode=sign_up`) — in-app upgrade/checkout lives at
// `/{prefix}/billing` and is Stripe-env-gated, so this PUBLIC page never hard-
// depends on a live Stripe key. The Team contact address is an OBVIOUS placeholder
// constant (see CONTACT_EMAIL) — replace it before launch; we never invent a real
// address.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Check,
  Minus,
  Sparkles,
  Rocket,
  Building2,
  type LucideIcon,
} from "lucide-react";

const EASE = "cubic-bezier(0.22,1,0.36,1)";
const CLAY = "var(--accent-500)";

// Sign-up entry point. Free + Pro both land here; in-app upgrade/checkout is the
// env-gated /{prefix}/billing page, so the public marketing surface only ever
// needs to route to account creation.
const SIGN_UP_HREF = "/auth?mode=sign_up";

// ⚠️ PLACEHOLDER — replace before launch. Mirrors how InvestorsPage refuses to
// invent contact details: this is an obviously-fake example address, not a real
// inbox. The Team-tier "Contact us" CTA points here via mailto:.
const CONTACT_EMAIL = "sales@agentdash.example";

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

// Fade-in + rise. Steady state is driven by React state (not CSS fill-mode) so it
// can never stall hidden. This is the FIXED Reveal from InvestorsPage: it reveals
// on mount when the block is already within (or near) the viewport, uses an
// IntersectionObserver for the scroll choreography, AND keeps a fallback timer so
// content is never stranded at opacity 0 inside this nested overflow-y-auto scroll
// region. When in doubt, it reveals.
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

// ---------------------------------------------------------------------------
// tier card
// ---------------------------------------------------------------------------

type Tier = {
  id: string;
  name: string;
  icon: LucideIcon;
  priceMajor: string; // big number / word, e.g. "$0", "$29", "Custom"
  priceSuffix?: string; // e.g. "/ seat / month"
  tagline: string;
  featured?: boolean;
  cta: { label: string; href: string };
  note?: string; // small line under the CTA, e.g. "14-day trial, no card"
  features: string[];
};

const TIERS: Tier[] = [
  {
    id: "free",
    name: "Free",
    icon: Sparkles,
    priceMajor: "$0",
    priceSuffix: "forever",
    tagline: "Stand up a Chief of Staff and watch a company build itself.",
    cta: { label: "Start free", href: SIGN_UP_HREF },
    features: [
      "1 human seat + 1 agent (your Chief of Staff)",
      "50 agent-runs / month",
      "The autonomous-company Test Drive",
      "CoS chat — design and steer your company",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    icon: Rocket,
    priceMajor: "$29",
    priceSuffix: "/ seat / month",
    tagline: "Bring your whole team and let the fleet run the operation.",
    featured: true,
    cta: { label: "Start 14-day trial", href: SIGN_UP_HREF },
    note: "14-day trial, no card required.",
    features: [
      "Everything in Free, plus:",
      "Unlimited humans + agents",
      "1,000 agent-runs / mo, +250 per additional seat",
      "Then $0.05 / run overage — only what you use",
      "Teammate invites + multi-human workspace",
      "CoS substrate: @-mention summons, shared org brain",
    ],
  },
  {
    id: "team",
    name: "Team",
    icon: Building2,
    priceMajor: "Custom",
    tagline: "Volume pricing and bespoke limits for larger operations.",
    cta: { label: "Contact us", href: `mailto:${CONTACT_EMAIL}` },
    features: [
      "Everything in Pro, plus:",
      "Volume pricing + custom run limits",
      "Priority support",
      "SSO (when available)",
    ],
  },
];

function TierCard({ tier, reduced }: { tier: Tier; reduced: boolean }) {
  const featured = !!tier.featured;
  const Icon = tier.icon;
  return (
    <div
      className="bg-card border rounded-2xl h-full flex flex-col"
      style={{
        padding: 24,
        position: "relative",
        borderColor: featured ? CLAY : "var(--border)",
        boxShadow: featured ? `0 0 0 1px ${CLAY}` : undefined,
        background: featured
          ? `color-mix(in oklab, ${CLAY} 4%, var(--card))`
          : undefined,
        transition: reduced ? undefined : `transform 200ms ${EASE}, border-color 200ms ${EASE}`,
      }}
      onMouseEnter={(e) => {
        if (reduced) return;
        e.currentTarget.style.transform = "translateY(-2px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      {featured ? (
        <span
          className="absolute"
          style={{
            top: -11,
            left: 24,
            fontSize: 10,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            color: "#fff",
            background: CLAY,
            borderRadius: 999,
            padding: "4px 10px",
          }}
        >
          Most popular
        </span>
      ) : null}

      {/* header */}
      <div className="flex items-center gap-2.5">
        <span
          className="bg-secondary"
          style={{
            width: 38,
            height: 38,
            borderRadius: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "none",
          }}
        >
          <Icon size={18} className="text-foreground" />
        </span>
        <span className="text-foreground" style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.02em" }}>
          {tier.name}
        </span>
      </div>

      {/* price */}
      <div style={{ marginTop: 18, display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span
          className="text-foreground"
          style={{ fontSize: 38, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1 }}
        >
          {tier.priceMajor}
        </span>
        {tier.priceSuffix ? (
          <span className="text-muted-foreground" style={{ fontSize: 13.5, fontWeight: 500 }}>
            {tier.priceSuffix}
          </span>
        ) : null}
      </div>

      <p className="text-muted-foreground" style={{ fontSize: 13.5, lineHeight: 1.5, marginTop: 12, minHeight: 40 }}>
        {tier.tagline}
      </p>

      {/* CTA */}
      <a
        href={tier.cta.href}
        className={
          featured
            ? "mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-5 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            : "mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full border border-border bg-card px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:border-[var(--accent-500)]"
        }
      >
        {tier.cta.label}
        <ArrowRight className="size-4" />
      </a>
      <div className="text-muted-foreground" style={{ fontSize: 11.5, marginTop: 8, minHeight: 16, textAlign: "center" }}>
        {tier.note ?? ""}
      </div>

      {/* features */}
      <ul style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
        {tier.features.map((f) => (
          <li key={f} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <Check
              className="text-[var(--accent-500)]"
              size={16}
              style={{ flex: "none", marginTop: 2 }}
            />
            <span className="text-foreground" style={{ fontSize: 13.5, lineHeight: 1.45 }}>
              {f}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// comparison matrix
// ---------------------------------------------------------------------------

type Cell = string | boolean;

const COMPARISON: { label: string; free: Cell; pro: Cell; team: Cell }[] = [
  { label: "Human seats", free: "1", pro: "Unlimited", team: "Unlimited" },
  { label: "Agents", free: "1 (Chief of Staff)", pro: "Unlimited", team: "Unlimited" },
  { label: "Agent-runs / month", free: "50", pro: "1,000 +250 / seat", team: "Custom" },
  { label: "Overage", free: false, pro: "$0.05 / run", team: "Custom" },
  { label: "Autonomous-company Test Drive", free: true, pro: true, team: true },
  { label: "Teammate invites", free: false, pro: true, team: true },
  { label: "Multi-human + CoS substrate", free: false, pro: true, team: true },
  { label: "Priority support", free: false, pro: false, team: true },
  { label: "SSO (when available)", free: false, pro: false, team: true },
];

function CompareCell({ value }: { value: Cell }) {
  if (value === true) {
    return <Check className="mx-auto text-[var(--accent-500)]" size={16} aria-label="Included" />;
  }
  if (value === false) {
    return <Minus className="mx-auto text-muted-foreground/50" size={16} aria-label="Not included" />;
  }
  return (
    <span className="text-foreground" style={{ fontSize: 12.5, fontWeight: 600 }}>
      {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "How does billing work?",
    a: "Pro is $29 per seat per month. You can start a 14-day trial with no card; once you upgrade in-app, billing is per active seat and you can change seat count any time.",
  },
  {
    q: "What counts as an agent-run?",
    a: "A run is one unit of agent work — an agent picking up a task and producing a result. Free includes 50 runs a month. Pro includes 1,000 runs a month plus 250 for each additional seat, then $0.05 per run beyond that.",
  },
  {
    q: "Do I need a credit card to try Pro?",
    a: "No. The 14-day Pro trial requires no card. Start free, and upgrade when you're ready to invite your team and lift the run limits.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Plans are month-to-month — cancel whenever you like and you keep access through the end of the period. Your company and its history stay intact.",
  },
];

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export function PricingPage() {
  const reduced = usePrefersReducedMotion();

  return (
    <div className="h-screen overflow-y-auto bg-background text-foreground">
      {/* top bar */}
      <header
        className="sticky top-0 z-40 bg-background/85 backdrop-blur"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="mx-auto flex w-full max-w-[1080px] items-center justify-between px-6 sm:px-7" style={{ height: 60 }}>
          <a href="/" aria-label="AgentDash">
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
              href={SIGN_UP_HREF}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-500)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              Start free
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
          style={{ padding: "72px 24px 28px", position: "relative" }}
        >
          <Reveal reduced={reduced}>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Sparkles className="size-3.5 text-[var(--accent-500)]" />
              Pricing
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
                maxWidth: 820,
              }}
            >
              Start free. Pay when your{" "}
              <span style={{ color: CLAY }}>team is running</span>.
            </h1>
          </Reveal>
          <Reveal reduced={reduced} delay={150}>
            <p
              className="text-muted-foreground"
              style={{ fontSize: 18, lineHeight: 1.6, marginTop: 20, maxWidth: 640 }}
            >
              Stand up a Chief of Staff for free and watch it build a company. Upgrade
              to bring your team, lift the run limits, and only pay for the work the
              fleet actually does.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ============================================================ TIERS */}
      <section style={{ scrollMarginTop: 72 }}>
        <div className="mx-auto w-full max-w-[1080px] px-6 sm:px-7" style={{ padding: "20px 24px 28px" }}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {TIERS.map((tier, i) => (
              <Reveal key={tier.id} reduced={reduced} delay={i * 80}>
                <TierCard tier={tier} reduced={reduced} />
              </Reveal>
            ))}
          </div>
          <Reveal reduced={reduced} delay={120}>
            <p className="text-muted-foreground" style={{ fontSize: 12.5, lineHeight: 1.6, marginTop: 18, textAlign: "center" }}>
              Free includes 1 human + 1 agent and 50 runs / month. Pro is $29 / seat /
              month with a 14-day no-card trial. Prices in USD.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ============================================================ COMPARE */}
      <section style={{ borderTop: "1px solid var(--border)", scrollMarginTop: 72 }}>
        <div className="mx-auto w-full max-w-[1080px] px-6 sm:px-7" style={{ padding: "64px 24px 72px" }}>
          <Reveal reduced={reduced}>
            <Eyebrow>Compare plans</Eyebrow>
            <h2
              className="text-foreground"
              style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.035em", lineHeight: 1.08, marginTop: 14, maxWidth: 720 }}
            >
              Everything, side by side.
            </h2>
          </Reveal>

          <Reveal reduced={reduced} delay={80}>
            <div className="mt-10 overflow-x-auto rounded-2xl border border-border bg-card">
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <th
                      className="text-muted-foreground"
                      style={{ textAlign: "left", fontSize: 12, fontWeight: 700, padding: "16px 18px", textTransform: "uppercase", letterSpacing: "0.08em" }}
                    >
                      Feature
                    </th>
                    {["Free", "Pro", "Team"].map((name) => (
                      <th
                        key={name}
                        style={{
                          textAlign: "center",
                          fontSize: 13.5,
                          fontWeight: 800,
                          padding: "16px 18px",
                          color: name === "Pro" ? CLAY : "var(--foreground)",
                          width: 150,
                        }}
                      >
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON.map((row, idx) => (
                    <tr
                      key={row.label}
                      style={{
                        borderTop: idx === 0 ? undefined : "1px solid var(--border)",
                        background: idx % 2 === 1 ? "color-mix(in oklab, var(--secondary) 40%, transparent)" : undefined,
                      }}
                    >
                      <td className="text-foreground" style={{ fontSize: 13.5, fontWeight: 500, padding: "13px 18px" }}>
                        {row.label}
                      </td>
                      <td style={{ textAlign: "center", padding: "13px 18px" }}>
                        <CompareCell value={row.free} />
                      </td>
                      <td
                        style={{
                          textAlign: "center",
                          padding: "13px 18px",
                          background: "color-mix(in oklab, " + "var(--accent-500)" + " 5%, transparent)",
                        }}
                      >
                        <CompareCell value={row.pro} />
                      </td>
                      <td style={{ textAlign: "center", padding: "13px 18px" }}>
                        <CompareCell value={row.team} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ============================================================ FAQ */}
      <section className="bg-secondary/40" style={{ borderTop: "1px solid var(--border)", scrollMarginTop: 72 }}>
        <div className="mx-auto w-full max-w-[1080px] px-6 sm:px-7" style={{ padding: "64px 24px 72px" }}>
          <Reveal reduced={reduced}>
            <Eyebrow>FAQ</Eyebrow>
            <h2
              className="text-foreground"
              style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.035em", lineHeight: 1.08, marginTop: 14, maxWidth: 720 }}
            >
              Questions, answered.
            </h2>
          </Reveal>

          <div className="mt-10 grid grid-cols-1 gap-3 md:grid-cols-2">
            {FAQ.map((item, i) => (
              <Reveal key={item.q} reduced={reduced} delay={i * 70}>
                <div className="bg-card border border-border rounded-2xl h-full" style={{ padding: 22 }}>
                  <div className="text-foreground" style={{ fontSize: 15.5, fontWeight: 700 }}>
                    {item.q}
                  </div>
                  <p className="text-muted-foreground" style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 8 }}>
                    {item.a}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============================================================ CTA + FOOTER */}
      <section style={{ borderTop: "1px solid var(--border)" }}>
        <div className="mx-auto w-full max-w-[1080px] px-6 sm:px-7" style={{ padding: "72px 24px 84px" }}>
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
                <h2
                  className="text-foreground"
                  style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.035em", lineHeight: 1.1, maxWidth: 640 }}
                >
                  Build a company in a minute — free.
                </h2>
                <p className="text-muted-foreground" style={{ fontSize: 16, lineHeight: 1.6, marginTop: 14, maxWidth: 600 }}>
                  No card, no setup. Describe what you do and your Chief of Staff takes
                  it from there. Upgrade only when you want your whole team in.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <a
                    href={SIGN_UP_HREF}
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-6 py-3.5 text-base font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    <Rocket className="size-5" />
                    Start free
                  </a>
                  <a
                    href="/trial"
                    className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-card px-6 py-3.5 text-base font-medium text-foreground transition-colors hover:border-[var(--accent-500)]"
                  >
                    See it build a company
                  </a>
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
              <a href="/pricing" className="transition-colors hover:text-foreground">Pricing</a>
              <a href="/trial" className="transition-colors hover:text-foreground">Test drive</a>
              <a href="/" className="transition-colors hover:text-foreground">Home</a>
              <a href="/investors" className="transition-colors hover:text-foreground">Investors</a>
              <a href="/auth" className="transition-colors hover:text-foreground">Sign in</a>
            </nav>
          </div>
        </div>
      </section>
    </div>
  );
}

export default PricingPage;
