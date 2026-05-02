# Claude Design System — AgentDash

Warm coral accent on off-cream surface. Serif headings, Inter body, generous spacing.

---

## Color tokens

| Token | Hex | Use |
|---|---|---|
| `--surface-page` | `#FAF9F6` | Page background |
| `--surface-raised` | `#FFFFFF` | Cards, modals, inputs |
| `--surface-sunken` | `#F1EFEA` | Inset wells, hover states |
| `--border-soft` | `#E8E5DD` | Default borders |
| `--border-strong` | `#C7C2B5` | Emphasis borders |
| `--text-primary` | `#1F1B16` | Body copy, headings |
| `--text-secondary` | `#5A544A` | Supporting text, labels |
| `--text-tertiary` | `#8C8678` | Timestamps, placeholders |
| `--text-inverse` | `#FAF9F6` | Text on dark/accent backgrounds |
| `--accent-500` | `#DD523A` | Primary CTA, focus rings |
| `--accent-400` | `#F46F4D` | Hover accent |
| `--accent-600` | `#C24332` | Pressed/active accent |
| `--accent-100` | `#FFE0D5` | Accent tint backgrounds |
| `--accent-200` | `#FFC2AA` | Focus ring color |
| `--success-500` | `#4D8A6A` | Success states |
| `--warn-500` | `#C99237` | Warning states |
| `--danger-500` | `#B5453E` | Error/blocked states |
| `--info-500` | `#4D6F8A` | Info states |

Dark mode: `.dark` class overrides surfaces and text to warm dark tones; accent stays coral.

---

## Typography tokens

| Token | Value | Use |
|---|---|---|
| `--font-serif` | Source Serif 4, Georgia | h1/h2/h3 headings |
| `--font-sans` | Inter, system-ui | Body, labels, UI |
| `--font-mono` | JetBrains Mono, ui-monospace | Code, terminals |
| `--text-xs` | 12px | Fine print, timestamps |
| `--text-sm` | 14px | Labels, captions |
| `--text-base` | 16px | Body copy |
| `--text-lg` | 18px | Lead text |
| `--text-xl` | 22px | h3 equivalent |
| `--text-2xl` | 28px | h2 equivalent |
| `--text-3xl` | 36px | h1 equivalent |
| `--text-display` | 48px | Hero headings |

h1/h2/h3 inherit serif via `typography.css`. Body and UI elements use sans.

---

## Spacing (4-px grid)

`--space-1` (4px) · `--space-2` (8px) · `--space-3` (12px) · `--space-4` (16px) · `--space-6` (24px) · `--space-8` (32px) · `--space-12` (48px) · `--space-16` (64px)

Cards use `p-6`. Buttons use `px-4 py-2`. Composer uses `px-4 py-4`.

---

## Radius + Shadow

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 6px | Tags, small chips |
| `--radius-md` | 10px | Inputs, small cards |
| `--radius-lg` | 16px | Large cards, modals |
| `--radius-pill` | 999px | Badges, pills |
| `--shadow-sm` | 0 1px 2px rgba(31,27,22,0.05) | Subtle lift |
| `--shadow-md` | 0 4px 12px rgba(31,27,22,0.08) | Cards, dropdowns |
| `--shadow-lg` | 0 16px 40px rgba(31,27,22,0.12) | Modals, overlays |

---

## Primitives

### Button variants

| Variant | Tailwind class | When to use |
|---|---|---|
| `default` | `bg-accent-500 text-text-inverse` | Primary action — one per screen |
| `outline` | `border border-border-soft bg-surface-raised` | Secondary action alongside a primary |
| `secondary` | `bg-surface-sunken border border-border-soft` | Tertiary / less prominent |
| `ghost` | `hover:bg-surface-sunken` | Icon buttons, toolbar actions |
| `destructive` | `bg-danger-500 text-text-inverse` | Destructive actions only |

### Card vs raw div

Use `<Card>` (from `ui/card.tsx`) when content is a self-contained unit with a visual boundary — billing status, proposal, invite prompt. Use a plain `div` for layout containers, list rows, and inline elements.

### Badge tones

`default` (coral accent) · `secondary` (neutral) · `destructive` (danger) · `outline` (subtle) · `ghost` (no border)

---

## Anti-patterns

- **No hardcoded hex.** Always use a token variable. `text-[#DD523A]` → `text-accent-500`.
- **No ALL CAPS.** Use `font-semibold` or `tracking-wide uppercase text-xs` for labels only.
- **No serif on body text.** Serif is for headings (h1/h2/h3) only. Body uses `--font-sans`.
- **No blue for CTAs.** The legacy code used `bg-blue-600`. All CTAs are `bg-accent-500` (coral).
- **No raw `<button>` with inline color styles** in new code — use the `<Button>` component or token classes.
