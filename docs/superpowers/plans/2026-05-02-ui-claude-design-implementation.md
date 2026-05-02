# UI redesign with Claude design — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Apply a Claude-style visual design system to AgentDash v2's UI. "Claude design" = Anthropic's product visual language: warm coral/orange accent on a near-white surface, generous spacing, mixed serif headings + clean sans body, soft shadows, rounded corners. No new components — restyle the components shipped by the other subsystems (ChatPanel, BillingPage, etc.).

**Architecture:** Single design-token source (Tailwind theme + CSS variables) consumed by every component. Restyling happens in three passes: tokens → primitives (Button, Card, Input) → screens (ChatPanel, BillingPage, sign-in/up). No component logic changes; only class names and a few semantic markup tweaks for accessibility.

**Tech Stack:** Tailwind CSS v4, CSS custom properties, React 19. Optionally: shadcn/ui primitives if/where they help, but no large dependency add.

---

## Prerequisites

- [ ] v2 base migration done (`main` branched from `upstream/master`).
- [ ] Onboarding plan, chat-substrate plan, billing plan all merged onto `main`. This plan applies a coat of paint over the components those plans created — runs **after** them.

If the plan runs before those components exist, the restyling has nothing to restyle. Order matters.

---

## File structure

**Created:**
| File | Responsibility |
|---|---|
| `ui/src/styles/tokens.css` | All design tokens as CSS custom properties |
| `ui/src/styles/typography.css` | Serif/sans pairing, sizing scale |
| `ui/tailwind.config.ts` | Maps tokens to Tailwind theme (or extends existing config) |
| `ui/src/styles/global.css` | Resets, body, scrollbar, focus rings |
| `ui/src/components/ui/Button.tsx` | Primitive |
| `ui/src/components/ui/Card.tsx` | Primitive |
| `ui/src/components/ui/Input.tsx` | Primitive |
| `ui/src/components/ui/Badge.tsx` | Primitive |
| `docs/design/claude-design-system.md` | One-page reference for the team |

**Modified (restyled, not rewritten):**
| File | Change |
|---|---|
| `ui/src/pages/ChatPanel.tsx` | Use new tokens + primitives |
| `ui/src/components/MessageList.tsx` | Same |
| `ui/src/components/Composer.tsx` | Same |
| `ui/src/components/cards/*.tsx` | Same |
| `ui/src/pages/BillingPage.tsx` | Same |
| `ui/src/components/UpgradePromptCard.tsx` | Same |
| `ui/src/components/TrialBanner.tsx` | Same |
| `ui/src/pages/SignIn.tsx` | Same |
| `ui/src/pages/SignUp.tsx` | Same |
| `ui/src/pages/SettingsPage.tsx` (if exists) | Same |
| `ui/index.html` | Add the typography font links |

---

## Phase 1 — Design tokens

### Task 1.1 — Define the token set

**Files:**
- Create: `ui/src/styles/tokens.css`

- [ ] **Step 1: Write the token file**

```css
/* ui/src/styles/tokens.css */
:root {
  /* Surface */
  --surface-page:       #FAF9F6;          /* near-white off-cream */
  --surface-raised:     #FFFFFF;          /* cards, modals */
  --surface-sunken:     #F1EFEA;          /* gentle inset */
  --border-soft:        #E8E5DD;
  --border-strong:      #C7C2B5;

  /* Text */
  --text-primary:       #1F1B16;          /* warm near-black */
  --text-secondary:     #5A544A;
  --text-tertiary:      #8C8678;
  --text-inverse:       #FAF9F6;

  /* Brand accent — Claude coral */
  --accent-50:          #FFF4F0;
  --accent-100:         #FFE0D5;
  --accent-200:         #FFC2AA;
  --accent-300:         #FF9E82;
  --accent-400:         #F46F4D;
  --accent-500:         #DD523A;          /* primary */
  --accent-600:         #C24332;
  --accent-700:         #9D3527;

  /* Semantic */
  --success-500:        #4D8A6A;
  --warn-500:           #C99237;
  --danger-500:         #B5453E;
  --info-500:           #4D6F8A;

  /* Shadow */
  --shadow-sm:          0 1px 2px rgba(31, 27, 22, 0.05);
  --shadow-md:          0 4px 12px rgba(31, 27, 22, 0.08);
  --shadow-lg:          0 16px 40px rgba(31, 27, 22, 0.12);

  /* Radius */
  --radius-sm:          6px;
  --radius-md:          10px;
  --radius-lg:          16px;
  --radius-pill:        999px;

  /* Spacing scale (4-px grid) */
  --space-1:            4px;
  --space-2:            8px;
  --space-3:            12px;
  --space-4:            16px;
  --space-6:            24px;
  --space-8:            32px;
  --space-12:           48px;
  --space-16:           64px;

  /* Type sizes */
  --text-xs:            12px;
  --text-sm:            14px;
  --text-base:          16px;
  --text-lg:            18px;
  --text-xl:            22px;
  --text-2xl:           28px;
  --text-3xl:           36px;
  --text-display:       48px;

  /* Line heights */
  --leading-tight:      1.2;
  --leading-snug:       1.4;
  --leading-normal:     1.6;
}

@media (prefers-color-scheme: dark) {
  :root {
    --surface-page:     #1A1814;
    --surface-raised:   #232017;
    --surface-sunken:   #15130F;
    --border-soft:      #2D2920;
    --border-strong:    #4A4536;
    --text-primary:     #F6F3EC;
    --text-secondary:   #B8B0A0;
    --text-tertiary:    #807868;
    --text-inverse:     #1A1814;
    /* accent stays */
  }
}
```

- [ ] **Step 2: Commit**

```sh
git add ui/src/styles/tokens.css
git commit -m "feat(ui): Claude-style design tokens"
```

### Task 1.2 — Typography

**Files:**
- Create: `ui/src/styles/typography.css`
- Modify: `ui/index.html`

- [ ] **Step 1: Add the font stack**

In `ui/index.html` `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Tiempos+Headline:wght@400;500;600&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

(If Tiempos is not freely available via Google, fall back to a similar serif: `Source Serif 4` or `Lora`. The plan uses Tiempos as a placeholder for "Claude's serif"; the actual font choice may require licensing.)

- [ ] **Step 2: Typography CSS**

```css
/* ui/src/styles/typography.css */
:root {
  --font-serif:  "Tiempos Headline", "Source Serif 4", Georgia, serif;
  --font-sans:   "Inter", "SF Pro Text", system-ui, -apple-system, sans-serif;
  --font-mono:   "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
}

html { font-family: var(--font-sans); color: var(--text-primary); background: var(--surface-page); }
h1, h2, h3 { font-family: var(--font-serif); font-weight: 500; line-height: var(--leading-tight); letter-spacing: -0.02em; }
h1 { font-size: var(--text-3xl); }
h2 { font-size: var(--text-2xl); }
h3 { font-size: var(--text-xl); }
body, p, li { font-size: var(--text-base); line-height: var(--leading-normal); }
.small { font-size: var(--text-sm); color: var(--text-secondary); }
code, pre { font-family: var(--font-mono); font-size: 0.95em; }
```

- [ ] **Step 3: Import both stylesheets at the app root**

```typescript
// ui/src/main.tsx (or equivalent entrypoint)
import "./styles/tokens.css";
import "./styles/typography.css";
import "./styles/global.css";
```

- [ ] **Step 4: Commit**

```sh
git add ui/src/styles/typography.css ui/index.html ui/src/main.tsx
git commit -m "feat(ui): Claude typography (serif headings, Inter body)"
```

### Task 1.3 — Tailwind config maps to tokens

**Files:**
- Modify: `ui/tailwind.config.ts`

- [ ] **Step 1: Extend Tailwind's theme**

```typescript
// ui/tailwind.config.ts
export default {
  // ...existing config
  theme: {
    extend: {
      colors: {
        surface: {
          page: "var(--surface-page)",
          raised: "var(--surface-raised)",
          sunken: "var(--surface-sunken)",
        },
        accent: {
          50: "var(--accent-50)",
          100: "var(--accent-100)",
          200: "var(--accent-200)",
          300: "var(--accent-300)",
          400: "var(--accent-400)",
          500: "var(--accent-500)",
          600: "var(--accent-600)",
          700: "var(--accent-700)",
        },
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          tertiary: "var(--text-tertiary)",
          inverse: "var(--text-inverse)",
        },
        border: {
          soft: "var(--border-soft)",
          strong: "var(--border-strong)",
        },
      },
      fontFamily: {
        serif: ["Tiempos Headline", "Source Serif 4", "Georgia", "serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        pill: "var(--radius-pill)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
    },
  },
};
```

- [ ] **Step 2: Run typecheck + dev**

```sh
pnpm -r typecheck
pnpm dev
```

Expected: dev server starts, page loads with the new color/typography defaults.

- [ ] **Step 3: Commit**

```sh
git add ui/tailwind.config.ts
git commit -m "feat(ui): Tailwind config maps to Claude tokens"
```

---

## Phase 2 — Primitive components

Building these once and reusing across the app keeps restyling work cheap.

### Task 2.1 — Button

**Files:**
- Create: `ui/src/components/ui/Button.tsx`

- [ ] **Step 1: Implement**

```tsx
// ui/src/components/ui/Button.tsx
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { clsx } from "clsx";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg";

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-accent-500 text-text-inverse hover:bg-accent-600 active:bg-accent-700 shadow-sm",
  secondary:
    "bg-surface-raised text-text-primary border border-border-strong hover:bg-surface-sunken",
  ghost:
    "bg-transparent text-text-primary hover:bg-surface-sunken",
  destructive:
    "bg-[var(--danger-500)] text-text-inverse hover:opacity-90",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3 text-sm rounded-sm",
  md: "h-10 px-4 text-base rounded-md",
  lg: "h-12 px-6 text-lg rounded-md",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
}>(function Button({ variant = "primary", size = "md", className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={clsx(
        "inline-flex items-center justify-center gap-2 font-medium transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...rest}
    />
  );
});
```

- [ ] **Step 2: Test**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "../Button";

it("renders text and fires onClick", () => {
  const onClick = vi.fn();
  render(<Button onClick={onClick}>Click me</Button>);
  fireEvent.click(screen.getByRole("button"));
  expect(onClick).toHaveBeenCalled();
});
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/components/ui/Button.tsx ui/src/components/ui/__tests__/Button.test.tsx
git commit -m "feat(ui): Button primitive (Claude design)"
```

### Task 2.2 — Card

**Files:**
- Create: `ui/src/components/ui/Card.tsx`

- [ ] **Step 1: Implement**

```tsx
// ui/src/components/ui/Card.tsx
import type { HTMLAttributes } from "react";
import { clsx } from "clsx";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        "bg-surface-raised border border-border-soft rounded-lg shadow-sm p-6",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("flex items-center justify-between gap-4 mb-4", className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={clsx("font-serif text-xl text-text-primary", className)} {...rest} />;
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("text-text-secondary", className)} {...rest} />;
}

export function CardActions({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("flex gap-3 mt-4", className)} {...rest} />;
}
```

- [ ] **Step 2: Commit**

```sh
git add ui/src/components/ui/Card.tsx
git commit -m "feat(ui): Card primitive set"
```

### Task 2.3 — Input + Badge

**Files:**
- Create: `ui/src/components/ui/Input.tsx`
- Create: `ui/src/components/ui/Badge.tsx`

- [ ] **Step 1: Input**

```tsx
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { clsx } from "clsx";

const baseInputClasses =
  "w-full bg-surface-raised border border-border-soft text-text-primary placeholder-text-tertiary " +
  "focus-visible:outline-none focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-200 " +
  "transition-colors disabled:opacity-50 rounded-md";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={clsx(baseInputClasses, "h-10 px-3 text-base", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={clsx(baseInputClasses, "min-h-24 p-3 text-base resize-y", className)} {...rest} />;
  },
);
```

- [ ] **Step 2: Badge**

```tsx
import type { HTMLAttributes } from "react";
import { clsx } from "clsx";

type Tone = "neutral" | "accent" | "success" | "warn" | "danger";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-text-secondary border-border-soft",
  accent:  "bg-accent-100 text-accent-700 border-accent-200",
  success: "bg-[#E8F0EB] text-[var(--success-500)] border-[#C8DDD0]",
  warn:    "bg-[#FAEBD0] text-[var(--warn-500)] border-[#E6CD92]",
  danger:  "bg-[#FAE3E1] text-[var(--danger-500)] border-[#E6BBB7]",
};

export function Badge({ tone = "neutral", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={clsx("inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium border rounded-pill", tones[tone], className)}
      {...rest}
    />
  );
}
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/components/ui/Input.tsx ui/src/components/ui/Badge.tsx
git commit -m "feat(ui): Input + Badge primitives"
```

---

## Phase 3 — Restyle screens (one task per surface)

Each task takes a screen built by another plan and restyles it without changing logic.

### Task 3.1 — ChatPanel + MessageList + Composer

**Files:**
- Modify: `ui/src/pages/ChatPanel.tsx`, `ui/src/components/MessageList.tsx`, `ui/src/components/Composer.tsx`

- [ ] **Step 1: Replace ad-hoc class names with primitives**

In `Composer.tsx`, swap the raw `<input>` for `<Textarea>` and the `<button>` for `<Button>`. In `MessageList.tsx`, swap inline divs for `<Card>` where messages are grouped.

Concrete diff sketch (not literal):

```tsx
// Before: <input className="..." />  →  After: <Textarea ... />
// Before: <button onClick={send}>↑</button>  →  After: <Button onClick={send} size="md" aria-label="Send">↑</Button>
```

- [ ] **Step 2: Add visual polish at the panel level**

In `ChatPanel.tsx`, wrap the message list in a max-width container, add a subtle top fade, ensure scroll-anchoring at the bottom:

```tsx
<div className="flex flex-col h-full bg-surface-page">
  <div className="flex-1 overflow-y-auto px-6 py-8">
    <div className="max-w-2xl mx-auto space-y-6">
      <MessageList ... />
    </div>
  </div>
  <div className="border-t border-border-soft bg-surface-raised px-6 py-4">
    <div className="max-w-2xl mx-auto"><Composer ... /></div>
  </div>
</div>
```

- [ ] **Step 3: Manual visual QA**

Start `pnpm dev`, log in, walk the chat flow. Confirm: warm cream background, white message cards, coral accent on Send button, serif headings if any (CoS name), comfortable line-height.

- [ ] **Step 4: Commit**

```sh
git add ui/src/pages/ChatPanel.tsx ui/src/components/MessageList.tsx ui/src/components/Composer.tsx
git commit -m "feat(ui): restyle ChatPanel + MessageList + Composer to Claude design"
```

### Task 3.2 — Cards (Proposal, InvitePrompt, AgentStatus, InterviewQuestion)

**Files:**
- Modify: `ui/src/components/cards/*.tsx`

- [ ] **Step 1: Each card uses the Card primitive**

Example for `ProposalCard`:

```tsx
import { Card, CardHeader, CardTitle, CardBody, CardActions } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";

export function ProposalCard({ payload, onConfirm, onReject }: ...) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{payload.name}</CardTitle>
        <Badge tone="accent">{payload.role}</Badge>
      </CardHeader>
      <CardBody>
        <p className="text-text-primary text-lg">{payload.oneLineOkr}</p>
        <p className="mt-3 text-sm">{payload.rationale}</p>
      </CardBody>
      <CardActions>
        <Button onClick={onConfirm}>Looks good →</Button>
        <Button variant="ghost" onClick={() => onReject()}>Try again</Button>
      </CardActions>
    </Card>
  );
}
```

(Apply analogous treatment to `InvitePrompt`, `AgentStatusCard`, `InterviewQuestion`.)

- [ ] **Step 2: Commit**

```sh
git add ui/src/components/cards/
git commit -m "feat(ui): restyle chat cards to Claude design"
```

### Task 3.3 — BillingPage + UpgradePromptCard + TrialBanner

**Files:**
- Modify: `ui/src/pages/BillingPage.tsx`, `ui/src/components/UpgradePromptCard.tsx`, `ui/src/components/TrialBanner.tsx`

- [ ] **Step 1: Replace ad-hoc styling**

`BillingPage`: wrap content in a centered max-width container, use `<Card>` for the status block, `<Button>` for actions, `<Badge>` for the tier name.

`UpgradePromptCard`: use `<Card>` + `<Button>`. Ensure the prompt visually distinguishes itself (accent border or accent background) without screaming.

`TrialBanner`: use a flat thin bar at the top of the chat, accent-100 background, accent-700 text, dismiss button aligned right.

- [ ] **Step 2: Commit**

```sh
git add ui/src/pages/BillingPage.tsx ui/src/components/UpgradePromptCard.tsx ui/src/components/TrialBanner.tsx
git commit -m "feat(ui): restyle billing surfaces to Claude design"
```

### Task 3.4 — Sign-in / sign-up

**Files:**
- Modify: `ui/src/pages/SignIn.tsx`, `ui/src/pages/SignUp.tsx` (whatever names exist after the v2 base migration)

- [ ] **Step 1: Apply the design**

A centered Card on the page, big serif headline ("Welcome to AgentDash" / "Create your workspace"), Inter body, `<Input>` + `<Button>` primitives. Logo top-left.

- [ ] **Step 2: Commit**

```sh
git add ui/src/pages/SignIn.tsx ui/src/pages/SignUp.tsx
git commit -m "feat(ui): restyle sign-in/sign-up to Claude design"
```

### Task 3.5 — Settings (and any remaining surfaces)

**Files:**
- Modify: any remaining pages introduced by the other subsystem plans (settings page, account page, etc.)

- [ ] **Step 1: Walk every page in the app**

```sh
ls ui/src/pages/*.tsx
```

For each page not already restyled, swap raw `<button>`, `<input>`, `<div className="card">` for primitives and tokens.

- [ ] **Step 2: Final commit**

```sh
git add ui/src/pages/
git commit -m "feat(ui): restyle remaining pages to Claude design"
```

---

## Phase 4 — Documentation

### Task 4.1 — One-page design system reference

**Files:**
- Create: `docs/design/claude-design-system.md`

- [ ] **Step 1: Write the reference**

Cover:
- Token table (color, type, spacing, radius, shadow) with hex values and intended use
- Primitive showcase: when to use Button primary vs secondary, when Card vs raw div, etc.
- Anti-patterns: don't bypass tokens with hardcoded hex; don't use ALL CAPS; don't put serif on body text

(This doc is for the team — no need for fancy formatting.)

- [ ] **Step 2: Commit**

```sh
git add docs/design/claude-design-system.md
git commit -m "docs(design): one-page Claude design system reference"
```

---

## Phase 5 — Verification

### Task 5.1 — Visual regression check

- [ ] **Step 1: Walk every screen in `pnpm dev`**

- Sign-up and sign-in
- Onboarding chat (every step: opening message, fixed questions, follow-ups, proposal card, invite prompt)
- Multi-human chat (open in two browsers; ensure cards render the same on both)
- Billing page
- Upgrade prompt card (force a 402 by hitting an invite cap on Free)
- Trial banner

Confirm:
- No raw browser-default styling visible (all colors token-driven).
- Focus rings visible and accent-colored.
- Disabled buttons readable.
- No broken contrast (manually eyeball; AA target).
- Dark mode toggles cleanly with `prefers-color-scheme`.

### Task 5.2 — Lighthouse / accessibility quick pass

- [ ] **Step 1: Run Lighthouse on `pnpm dev`**

```sh
# In Chrome devtools, Lighthouse > Accessibility audit on /, /billing, /chat
```

Target: ≥95 on Accessibility. Fix any contrast / aria-label findings before merging.

### Task 5.3 — Open the PR

Title: `feat(ui): Claude design system applied across v2`

```sh
git push -u origin <branch>
gh pr create --base main --head <branch> --title "feat(ui): Claude design system" --body "$(cat << 'EOF'
Applies a Claude-style design system across the v2 UI:
- Token-driven color, typography, spacing, radius, shadow
- Primitives: Button, Card, Input, Textarea, Badge
- Restyled: ChatPanel, MessageList, Composer, all chat cards, BillingPage,
  UpgradePromptCard, TrialBanner, sign-in/sign-up, settings.
- Dark mode via prefers-color-scheme.
- Lighthouse accessibility: ≥95 on touched routes.

No logic changes.
EOF
)"
```

---

## Decisions baked in

| Decision | Choice |
|---|---|
| "Claude design" interpretation | Anthropic web brand: warm coral accent, off-cream surface, serif headings + Inter body |
| Token transport | CSS custom properties + Tailwind theme extension |
| Dark mode | `prefers-color-scheme: dark`; no manual toggle in v1 |
| Font sourcing | Google Fonts (Inter, JetBrains Mono); Tiempos Headline placeholder with Source Serif 4 fallback |
| Primitive set | Button, Card, Input/Textarea, Badge — minimal viable set |
| When to apply | After all four other subsystem plans land — restyle existing components |

## What this plan does NOT do

- Add new components or new screens. (Other plans own that.)
- Animate transitions or build a motion system. (v1.1.)
- Build a Storybook or component documentation tool. (Markdown reference is enough.)
- Procure licensed fonts (Tiempos, etc.) — use free fallbacks until licensing is decided.
