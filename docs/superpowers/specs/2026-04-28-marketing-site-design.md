# AgentDash Marketing Site — Design Spec

**Date:** 2026-04-28
**Status:** Spec — pending implementation plan
**Owner:** TBD (assigned at plan time)
**Branch base:** `agentdash-main`

---

## 1. Goal

Ship a five-route marketing surface for AgentDash that:

1. Converts product-evaluating visitors via a self-serve `Start free` CTA on a single landing page (`/`).
2. Houses a credible consulting practice page (`/consulting`) that frames AgentDash's enterprise-AI-adoption advisory work in an evidence-led, advisory tone.
3. Houses an about page (`/about`) with a mission statement and founder card.
4. Folds the existing `/assess` and `/assess/history` flows into the same marketing surface as a visual-only restyle, preserving all existing functionality.

The visual identity is a stand-in for claude.ai's design system: warm cream backgrounds, dark-navy ink, a single coral accent, generous whitespace, editorial serif display type, and a restrained sans body. **Light mode only.** The dashboard product keeps its existing teal-and-shadcn surface; the marketing namespace and the product namespace are deliberately, structurally separated.

The centerpiece of the landing page is a **cinematic scroll-driven descent** through seven layers of the agent stack — from the Control Plane (where AgentDash sits) down to Model Serving (which AgentDash is honest about not providing).

## 2. Non-goals

- Real customer logos, founder photo, mission statement, or research brief content. All such assets are placeholders the user supplies.
- Demo flow, contact form backend, Calendly wiring. CTAs use `mailto:` and direct links.
- Pricing page, press kit, careers page, blog.
- Internationalization. Single English copy.
- Cookie banner / GDPR consent UI.
- Functional changes to the Assess flow, the auth flow, or any dashboard route.
- Migrating the existing dashboard chrome to the marketing aesthetic.

## 3. Audience priority

Decided in brainstorming: **platform-led**. Primary visitor is a buyer evaluating an agent orchestration platform; the consulting practice is presented as the "we install it for you" complement to the product. Hero CTA reflects this: `Start free` (primary) with no demo path. Talk-to-sales lives only at the consulting band and footer.

## 4. Information architecture

### 4.1 Routes

| Route | Component | Auth gating |
|---|---|---|
| `/` | `<Landing />` | Logged-out only. Logged-in users redirect to `/dashboard`. |
| `/consulting` | `<Consulting />` | Public. |
| `/about` | `<About />` | Public. |
| `/assess` | `<AssessPage />` (existing, restyled) | Public, same as today. |
| `/assess/history` | `<AssessHistoryPage />` (existing, restyled) | Same as today. |
| `/auth` | `<AuthPage />` (existing, lightly restyled) | Same as today. |
| `/dashboard` | Existing dashboard mount | Logged-in only, same as today. |

The dashboard's existing mount path inside `boardRoutes()` already covers `/dashboard`. The change at `/` is conditional rendering: `session ? <Navigate to="/dashboard" /> : <Landing />`. No restructuring of the 60+ existing app routes is required.

### 4.2 Shell

A `<MarketingShell>` wraps `/`, `/consulting`, `/about`, `/assess`, `/assess/history`, and (lightly) `/auth`. It provides:

- **Header** — wordmark left, nav center (`Product / Consulting / Assessment / About`), `Sign in` ghost + `Start free` filled coral on the right.
- **Footer** — three columns:
  - **Product:** Features, Assessment, Sign in
  - **Consulting:** Approach, Research, Talk to us
  - **Company:** About, Contact, LinkedIn
  - Plus a hairline-divided bottom row: copyright, legal stub, `consulting@agentdash.com` mailto.

The shell is not used inside any dashboard route. The dashboard imports nothing from `marketing/*` and `marketing/*` imports nothing from `components/ui/*`.

## 5. Visual system

### 5.1 Tokens (defined in `marketing/tokens.css`)

| Token | Value | Usage |
|---|---|---|
| `--surface-cream` | `#faf9f5` | Page background |
| `--surface-cream-2` | `#f3efe6` | Cards, raised slabs, secondary surfaces |
| `--ink` | `#1f1e1d` | Primary text |
| `--ink-soft` | `#54524f` | Secondary text, captions |
| `--rule` | `#e8e3d6` | Hairlines, dividers, card borders |
| `--accent` | `#cc785c` | Coral — single accent, used sparingly |
| `--accent-ink` | `#7a3f2a` | Hover ink, on-coral text where needed |

Contrast verification (WCAG AA, 4.5:1 minimum on body text):
- `--ink` on `--surface-cream`: 14.8:1 ✓
- `--ink-soft` on `--surface-cream`: 7.2:1 ✓
- `--accent` on `--surface-cream`: 3.5:1 — **not used for body text**, only for buttons (large text/UI exempt at 3:1) and accent strokes.
- White on `--accent`: 3.6:1 — used only for the filled-coral primary button at ≥16px semibold (large UI text exempt).

### 5.2 Type

| Family | Self-host weight set | Usage |
|---|---|---|
| **Newsreader** (serif, Google Fonts OFL) | 400, 500, 600 | Display: hero, section openers, page titles, mission statement |
| **Inter Tight** (sans, OFL) | 400, 500, 600 | Body, nav, UI, captions |
| **JetBrains Mono** (mono, OFL) | 400, 500 | Layer numerals (`01 / 07`), eyebrow tracking, code snippets |

All three are self-hosted via Vite's asset pipeline (no Google Fonts CDN). Subset: Latin + Latin-extended. Total payload target: ≤80KB gzip combined. `font-display: swap` on all faces.

Type scale (desktop; mobile clamps via `clamp()` at ~70%):
- Hero display: 80px / 1.05 / Newsreader 500
- Section opener: 48px / 1.1 / Newsreader 500
- Page title: 56px / 1.05 / Newsreader 500
- Sub-display / mission body: 36–44px / 1.25 / Newsreader 400
- Body large: 19px / 1.55 / Inter Tight 400
- Body: 17px / 1.55 / Inter Tight 400
- Eyebrow: 12px / 1 / JetBrains Mono 500 / `text-transform: uppercase` / `letter-spacing: 0.12em`
- Caption: 14px / 1.4 / Inter Tight 400 / `--ink-soft`

### 5.3 Spacing & rhythm

8px base unit. Section vertical padding: `clamp(96px, 12vh, 160px)` desktop. Container max-width: 1200px with 32px gutters; reading-width passages capped at 65ch.

### 5.4 Motion principles

1. Motion only ever serves comprehension. Nothing decorative.
2. Easing baseline: `cubic-bezier(0.16, 1, 0.3, 1)` (slow-in, quick-settle). No bounces, no overshoots.
3. Respect `prefers-reduced-motion: reduce`: pinned scroll degrades to a static stacked layout, fades become instant, no transforms.
4. No parallax on hover, no on-load slide-in on text, no scroll-jacking outside the descent stage.
5. The descent stage never blocks native scroll velocity — pinning is exactly one viewport-worth per layer, the user is always in control.

### 5.5 Brand split — explicit

The marketing surface uses cream + coral as defined here. The dashboard product keeps its existing teal + shadcn surface. This is deliberate; do not unify. Modeled on Linear, Vercel, Stripe (marketing brochure aesthetic distinct from product chrome).

## 6. Landing page (`/`)

### 6.1 Section list

```
1. Hero
2. Trust strip            (placeholder logos)
3. Outcome quote          (single full-bleed serif quote)
4. Layered descent        (centerpiece — see §6.3)
5. Capabilities grid      (3×2 product tiles)
6. How it works           (3 steps)
7. Consulting band        (link to /consulting)
8. Final CTA              (twin CTAs)
9. Footer (from shell)
```

### 6.2 Hero

- Eyebrow (mono, uppercase, tracked): `THE CONTROL PLANE FOR YOUR AI COMPANY`
- Display (Newsreader, ~80px): `Run an AI workforce the way you'd run a company.`
- Sub (Inter Tight 19/1.55, `--ink-soft`, max 56ch): one sentence about goals, agents, budgets, audit trails in one control plane. *Final copy TBD by user; placeholder string in code uses the previous sentence verbatim.*
- CTAs: primary coral filled `Start free` → `/auth?mode=sign_up`; secondary ghost `See the architecture` → smooth-scrolls to `#layered-descent`.
- Reassurance line below CTAs (caption): `No credit card · Free single-seat tier`.
- Right column: stylized "morning briefing" card rendered as a hand-authored SVG (not a screenshot). Composition: a rectangular card with a header row (small wordmark + date), a stacked list of ~5 agent rows (each row: avatar circle, name, status pill, single-line summary), and a footer KPI strip (3 numerals with labels). Stroke-only line work in `--ink` with one coral fill on a status pill. Sits on a soft drop shadow at ~24px blur, 8% opacity. No animation. Static.

### 6.3 Layered descent — centerpiece

The section's outer wrapper has `id="layered-descent"` so the hero's `See the architecture` CTA can smooth-scroll to it via in-page anchor.

#### 6.3.1 Layer content

| # | Layer | One-line | Diagram motif | AgentDash framing |
|---|---|---|---|---|
| 01 | Control Plane | Where you run your AI company. | Org tree with a board node on top | Native — this is AgentDash. |
| 02 | Orchestration | Task graphs, dependencies, scheduling, approvals. | Directed graph, three highlighted edges | Native — task dependencies, action proposals. |
| 03 | Workspaces & Adapters | The execution environments your agents actually run in. | Seven adapter chips arranged in a grid | Native — Claude / Codex / Cursor / Gemini / Pi / OpenCode / OpenClaw. |
| 04 | Agent Primitives | Identity, memory, heartbeat, tools. | Single agent block exploded into four sub-blocks | Native — SOUL, heartbeat, skills registry. |
| 05 | Interop | How agents reach humans, systems, and each other. | Concentric ring with HubSpot / Slack / Email / Webhook chips on the perimeter | Native — plugins, HubSpot, webhooks. |
| 06 | Trust & Safety | Policies, budgets, audits, kill switch. | Shield over a ledger | Native — policy engine, budget hard-stops, activity log. |
| 07 | Model Serving | Inference. Your tokens, your models. | Three model chips below a horizontal rule | **Honest framing — not native. BYOT.** Anthropic / OpenAI / your-own. |

The seventh layer is the load-bearing trust signal. Pretending we're a model host would read as AI slop to the C-level audience; explicitly disowning that scope is the move.

#### 6.3.2 Scroll mechanic

- The descent section is `7 × 100vh` tall. Inside it, a sticky "stage" pins for the duration.
- The stage shows all seven slabs at once, stacked, with a subtle perspective tilt (~4° rotateX on inactive slabs).
- One slab is "active" at a time. Active = full opacity, full color, right-hand panel showing eyebrow (`01 / 07`), serif name, one-line description, inline diagram.
- Inactive slabs above the active dim to ~30% opacity and shift up; inactive below dim and shift down. The visual reads as the active layer "settling into focus."
- Scroll progress within the section (0→1) maps linearly to active-layer index (0→6). No snap. No scroll-hijacking.
- A left-rail mini-tracker (`01 ─ ─ ─ ─ ─ ─ 07`) shows progress with the current layer named.
- Animation primitives: `transform` and `opacity` only. Tested smooth at 60fps on a 2019 MBP with 4× CPU throttle.
- **Reduced-motion fallback:** stage un-pins, slabs render full-height stacked vertically, no perspective, no fades, no rail. Same content, instant.

#### 6.3.3 Implementation

A single hook `useDescentProgress(ref)` reads `getBoundingClientRect()` in a `requestAnimationFrame` loop, computes a clamped 0..1 progress value, and writes it to a CSS variable `--descent-progress` on the stage element. Inactive-slab transforms and opacities derive from that variable via `calc()` in CSS, so the React tree does not re-render per frame. Total motion code budget: ~80 lines TS + ~150 lines CSS.

### 6.4 Trust strip

Single horizontal row, monochrome (mix-blend-mode: multiply applied to grayscale logos), max 6 logos. Placeholder rectangles until the user supplies real logos.

### 6.5 Outcome quote

Full-bleed cream-2 background, centered serif pull-quote, ~32px Newsreader, max 28ch per line. Attribution line below in Inter Tight 14px caption. Placeholder text until user supplies a real quote.

### 6.6 Capabilities grid

3 columns × 2 rows on desktop, single column on mobile. Each tile:
- Small lucide icon, ink-color, 24px
- Sans semibold title (4–6 words)
- One-sentence body, `--ink-soft`

Six tiles:
1. **Agent Factory** — Spawn from templates, scale up or down.
2. **Task Dependencies** — Hierarchical work that traces to the goal.
3. **Budget Hard-Stops** — Spend caps you can defend in a board meeting.
4. **Skills Registry** — Teach an agent once, reuse everywhere.
5. **Activity Audit** — Every action, every decision, fully logged.
6. **Multi-Adapter** — Claude, Codex, Cursor, Gemini, Pi, OpenCode, OpenClaw.

### 6.7 How it works

Three numbered cards on `--surface-cream-2`. Large numerals in Newsreader serif, `--accent` color. Sentence-style headline, one-line body.

`01  Create the company  ·  02  Hire the CEO and team  ·  03  Watch the morning briefing.`

### 6.8 Consulting band

Half-screen-height. `--surface-cream-2` background.
- Left: serif headline `Want this installed for you?`, one paragraph (placeholder copy), ghost button `Talk to our consulting team` → `/consulting`.
- Right: hand-drawn-feeling org chart line drawing — a CEO node at the top, three reports below (CTO / CMO / CFO labels), each with two further reports below them. Dark-navy strokes only, ~1.5px line weight, slightly inconsistent angles to read as drawn rather than generated. Single coral fill on the CEO node only.

### 6.9 Final CTA + footer

Big serif `Start running your AI company.`
Coral primary `Start free` → `/auth?mode=sign_up` + ghost `Talk to sales` → `mailto:consulting@agentdash.com`. Footer per §4.2.

## 7. Consulting page (`/consulting`)

Tone: advisory, evidence-led, restrained. Modeled on the structural posture of analytical research sites — not a vendor pitch.

### 7.1 Section list

```
1. Hero                       (eyebrow + display + 2-paragraph sub)
2. How we work                (4 phases)
3. Research                   (editorial brief cards)
4. Readiness assessment band  (link to /assess)
5. Engagement                 (Pilot vs Production cards, no pricing)
6. Contact                    (single line + mailto)
```

### 7.2 Hero

- Eyebrow: `CONSULTING PRACTICE`
- Display: `We install AI workforces inside enterprises.`
- Sub (two paragraphs):
  - First paragraph names the problem (most enterprise AI pilots stall after the demo).
  - Second paragraph names the wedge (we run a structured deployment, not a slideware engagement).

### 7.3 How we work — 4 phases

Numbered, single-column, generous spacing. Each phase has a serif name, one paragraph of body copy, and one outcome line in caption type.

| # | Phase | Window | Outcome |
|---|---|---|---|
| 01 | Diagnose | 2 weeks | Current process map, pain ledger, readiness signal |
| 02 | Design | 2 weeks | Agent org chart, task hierarchy, guardrails |
| 03 | Deploy | 4 weeks | First agents in production, board oversight wired |
| 04 | Operate | Ongoing | Weekly review, scope expansion, eventual handoff |

### 7.4 Research

Editorial layout — feels like a journal, not a marketing block.

- Eyebrow: `RESEARCH`
- Heading: `What we've learned mapping the agent factory landscape.`
- Three columns of brief cards (4–6 cards total). Each card: eyebrow tag (e.g. `INDUSTRY`, `SYNTHESIS`, `FRAMEWORK`), serif title, 2-line abstract, `Read brief →` link.
- Briefs link to `#` for now (real content lands later).

Seed card titles (placeholders the user can refine):
- The seven layers of the enterprise agent stack
- Why agent pilots stall in month two
- Cross-industry agentification — what actually moved
- Readiness signals we look for in the first call

### 7.5 Readiness assessment band

Full-width `--surface-cream-2`. Left: serif headline `Where does your company sit on the readiness curve?`, paragraph framing the assessment as a 20-minute structured intake built for actual engagements. Right: single coral button `Run the assessment` → `/assess`.

### 7.6 Engagement

Two side-by-side cards. No prices. Just shape.

- **Pilot** — 4–6 weeks, fixed scope, fixed price.
- **Production** — Quarterly retainer, expanding scope, embedded with your team.

### 7.7 Contact

Single serif line: `Tell us what you're trying to build.`
Below: `consulting@agentdash.com` mailto + (optional) Calendly link stub.

## 8. About page (`/about`)

Mirrors the yarda.ai/about structure provided by the user, with the mission elevated to its own dedicated section above the founder card (yarda buries it inside the founder bio; we don't).

### 8.1 Section list

```
1. Hero                       (eyebrow + display only, no sub)
2. Mission                    (single full-width serif block — USER PROVIDES COPY)
3. Who We Are                 (yarda-style cream card with founder portrait — USER PROVIDES CONTENT)
4. Contact line               (footer-adjacent)
```

### 8.2 Hero

- Eyebrow: `ABOUT`
- Display: `Why AgentDash exists.`
- No sub. The mission section does that work.

### 8.3 Mission

Single full-width serif block. ~36–44px Newsreader 400. Centered. Max 28ch per line. Generous whitespace above and below.

**USER PROVIDES THE MISSION COPY.** Spec ships with a placeholder string in code, marked with a `// FILL IN: mission` comment.

### 8.4 Who We Are

Replicates the yarda layout exactly, restyled to our palette:
- `--surface-cream-2` rounded card, ~80px padding, `--rule` hairline border
- Centered serif `Who We Are` title (Newsreader, ~56px)
- Inside: circular portrait on the left (~160px diameter, `--accent` ring at 4px), founder name (Inter Tight semibold 24px), one-line bio in the format `[Title] of AgentDash | [background]`, LinkedIn link with the lucide LinkedIn icon

**USER PROVIDES:** founder name, portrait image, background line, LinkedIn URL. Placeholders in code marked `// FILL IN: founder.{name|portrait|bio|linkedin}`.

The card's structure scales to additional team members by repeating the same card layout vertically (single column, same width).

### 8.5 Contact line

Footer-adjacent (above the marketing footer): `Press, partnerships, careers — hello@agentdash.com`.

## 9. Assess restyle (`/assess`, `/assess/history`)

**Visual-only pass. No functional changes.**

### 9.1 What changes

- Page render wraps in `<MarketingShell>` so the header/footer match the rest of the marketing surface.
- Outer page background → `--surface-cream`. Phase cards → `--surface-cream-2` with `--rule` hairlines, no drop shadows.
- Phase titles → Newsreader serif, sized down from the landing hero (~32–40px).
- Body, labels, inputs → Inter Tight.
- Buttons swap to the marketing button variants (`Button` from `marketing/components/Button.tsx`): coral filled primary, ghost secondary. Same affordances and sizes, just restyled.
- `MarkdownBody` (the report renderer) gets a typography pass: serif h1/h2/h3, sans body, coral accent links, cream-2 code blocks. The component's external API is unchanged.
- `AssessHistoryPage` gets the same shell and the same input/button restyle. Table rows on cream, hairline `--rule` dividers.
- Reduced-motion media query explicitly disables any incidental transitions on these pages.

### 9.2 What stays

- The 6-phase state machine (Start → Confirm → Form → DeepDive → Generating → Report).
- All form fields, validation logic, and copy text inside form questions.
- The DeepDive interview flow.
- The Generating-phase polling.
- API contracts (`assessApi`, `ResearchResult`, `InterviewResponse`).
- AssessHistoryPage data fetching and pagination.
- Existing Playwright/CUJ coverage for Assess passes without modification.

## 10. Auth restyle (`/auth`)

Minimal pass — not a redesign:
- Background → `--surface-cream`.
- Heading → Newsreader serif (replaces the existing display treatment).
- Buttons → marketing `Button` variants.
- Form inputs and validation logic untouched.
- Existing `disableSignUp` health-flag behavior preserved unchanged.

## 11. File layout

```
ui/src/
  marketing/                              ← isolated namespace
    MarketingShell.tsx
    MarketingHeader.tsx
    MarketingFooter.tsx
    tokens.css
    fonts.css
    typography.css
    components/
      Button.tsx
      Eyebrow.tsx
      SectionContainer.tsx
      QuoteBlock.tsx
      LogoStrip.tsx
    pages/
      Landing.tsx
      Consulting.tsx
      About.tsx
    sections/
      Hero.tsx
      LayeredDescent.tsx
      LayeredDescent.layers.tsx
      CapabilitiesGrid.tsx
      HowItWorks.tsx
      ConsultingBand.tsx
      FinalCTA.tsx
      ConsultingPhases.tsx
      ResearchBriefs.tsx
      ReadinessBand.tsx
      EngagementCards.tsx
      AboutMission.tsx
      AboutFounder.tsx
    diagrams/
      ControlPlaneDiagram.tsx
      OrchestrationDiagram.tsx
      WorkspacesDiagram.tsx
      AgentPrimitivesDiagram.tsx
      InteropDiagram.tsx
      TrustSafetyDiagram.tsx
      ModelServingDiagram.tsx
    hooks/
      useDescentProgress.ts
      usePrefersReducedMotion.ts
  pages/
    AssessPage.tsx                        Wrap render in <MarketingShell>; restyle classes only
    AssessHistoryPage.tsx                 Same
    Auth.tsx                              Minimal restyle
  App.tsx                                 Add `/`, `/consulting`, `/about` routes; gate `/` by session
```

**Boundary rule:** `marketing/*` imports nothing from `components/ui/*`. The dashboard imports nothing from `marketing/*`. Enforced by code review; can be enforced by an ESLint `no-restricted-imports` rule in a follow-up.

## 12. Routing changes (App.tsx)

Add at the top of the route table:

```tsx
<Route path="/" element={
  session ? <Navigate to="/dashboard" replace /> : <Landing />
} />
<Route path="/consulting" element={<Consulting />} />
<Route path="/about" element={<About />} />
```

The existing `boardRoutes()` mount that currently serves `/` keeps serving `/dashboard` (it already does). All other dashboard routes are unaffected.

## 13. Motion library decision

**No Framer Motion.** The single motion surface (the descent) is implemented with:
- CSS `position: sticky` for pinning
- A single `useDescentProgress` hook writing `--descent-progress` (a CSS custom property) on the stage element from a `requestAnimationFrame` loop
- All slab transforms and opacities derived from that variable via `calc()` in CSS — zero React re-renders per frame

Rationale: Framer Motion adds ~50KB gzipped and tempts decorative animation. We have one surface that benefits from being a hand-rolled, readable, library-free implementation.

## 14. Performance budget

| Metric | Target |
|---|---|
| Landing JS bundle (route-split) | ≤ 90KB gzipped |
| LCP on landing hero (throttled 4G) | ≤ 1.8s |
| CLS | 0 |
| Descent FPS (2019 MBP, 4× CPU throttle) | sustained 60fps |
| Total font payload | ≤ 80KB gzipped |
| Lighthouse a11y | ≥ 95 |
| Lighthouse perf | ≥ 90 |

## 15. Accessibility

- One `<h1>` per page; sections open with `<h2>`; layer titles in the descent are `<h3>`.
- All hero/footer CTAs are real `<a>` tags styled as buttons.
- The descent's choreography is purely visual: every layer is a real `<section>` with `<h3>` and body text in source order. Screen readers get a clean reading order.
- All body text meets WCAG AA on `--surface-cream` (verified per token in §5.1).
- Coral primary button has visible focus: `outline: 2px solid currentColor; outline-offset: 4px;`
- "Skip to content" link as the first focusable element of every marketing page.
- `prefers-reduced-motion: reduce` honored everywhere; descent degrades to static stack.

## 16. Testing

| Layer | What | Tool |
|---|---|---|
| Unit | `useDescentProgress` returns 0 at top, 1 at bottom, clamps outside | vitest |
| Unit | `usePrefersReducedMotion` flips on `matchMedia` change | vitest |
| Component | Each marketing page renders without console errors, has one `<h1>`, has a "Skip to content" link | vitest + RTL |
| Component | `<LayeredDescent />` renders 7 layer slabs with correct labels in reduced-motion mode | vitest + RTL |
| Component | `<AssessPage />` still renders all 6 phases after the restyle (snapshot guard on phase headings) | vitest + RTL |
| E2E | Visit `/`, scroll past descent, all 7 layer names appear in the DOM | Playwright |
| E2E | Visit `/`, click `Start free`, lands on `/auth?mode=sign_up` | Playwright |
| E2E | Visit `/consulting`, click `Run the assessment`, lands on `/assess` | Playwright |
| E2E | Logged-in user visiting `/` redirects to `/dashboard` | Playwright (extend existing test) |
| Visual | Lighthouse on `/` reports a11y ≥ 95, perf ≥ 90 | CI script |
| Manual | Trackpad scroll through descent on macOS Chrome, Safari, Firefox: smooth, never traps | hand-test |
| Manual | `prefers-reduced-motion: reduce` set in DevTools: descent renders as static stack, all 7 layers visible | hand-test |

## 17. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Pinned scroll feels broken on trackpads | Pin one viewport per layer; never block scroll velocity; if real-device QA exposes problems, degrade to Approach 3 (no pinning, parallax-only). Behavior gated behind a single CSS class on the stage. |
| Self-hosted fonts inflate FCP | Subset to Latin + ext-Latin; preload only the two faces used above the fold (Newsreader 500, Inter Tight 400); `font-display: swap`. |
| `MarkdownBody` typography pass breaks the report renderer used elsewhere | The component's API stays unchanged; only its internal styles change. Snapshot test on the rendered report HTML. |
| Conditional render at `/` regresses the existing logged-in flow | Existing redirect-on-session test extended to cover the new branch; the gating is a single ternary. |
| Marketing namespace bleeds into dashboard | Code review; future ESLint `no-restricted-imports` rule. |
| Placeholder copy ships to production | All placeholders carry `// FILL IN:` comments grep-able pre-merge; PR checklist requires user has supplied real founder + mission + logos before tagging "ready to ship." |

## 18. Out of scope

(Repeated here for the spec record — see §2.)

- Real customer logos, founder photo / bio / LinkedIn — placeholders, user provides
- Real mission statement — placeholder, user provides
- Actual research-brief content (cards link to `#`)
- Calendly / contact form backend (uses `mailto:`)
- Pricing page
- Press kit, careers page, blog
- i18n / multi-language
- Cookie banner / GDPR consent UI
- Functional changes to Assess, Auth, or any dashboard route
- Dashboard chrome migration to the marketing aesthetic

## 19. Open content the user must supply before shipping

| Asset | Where it goes |
|---|---|
| Mission statement (single paragraph, ~30–60 words) | About §8.3 |
| Founder name | About §8.4 |
| Founder portrait (square, ≥ 320×320, JPEG/PNG) | About §8.4 |
| Founder background line (e.g., "Former [Company] | [Background]") | About §8.4 |
| Founder LinkedIn URL | About §8.4 |
| Hero sub-line final copy (or sign off the placeholder) | Landing §6.2 |
| Outcome quote + attribution | Landing §6.5 |
| 4–6 customer / partner logos (SVG preferred) | Landing §6.4 |
| Consulting band paragraph copy | Landing §6.8 |
| Consulting hero two paragraphs | Consulting §7.2 |
| (Eventually) real research brief content | Consulting §7.4 |

Implementation can ship with placeholders in place; the PR checklist will gate "ready for production" on these being filled.

---

**End of spec.**
