// AgentDash: dev/review-only segmented control to flip avatar treatments.
import type { AvatarVariant } from "./avatar-geometry";

const OPTIONS: { value: AvatarVariant; label: string }[] = [
  { value: "restrained", label: "Restrained" },
  { value: "playful", label: "Game energy" },
];

export function AvatarVariantSwitch({
  value,
  onChange,
}: {
  value: AvatarVariant;
  onChange: (v: AvatarVariant) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Avatar treatment"
      style={{
        display: "inline-flex",
        padding: 2,
        gap: 2,
        background: "var(--surface-sunken)",
        border: "1px solid var(--border-soft)",
        borderRadius: "var(--radius-pill)",
      }}
    >
      {OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            style={{
              padding: "4px 14px",
              fontSize: "var(--text-sm)",
              fontWeight: active ? 600 : 500,
              borderRadius: "var(--radius-pill)",
              border: "none",
              cursor: "pointer",
              color: active ? "var(--text-inverse)" : "var(--text-secondary)",
              background: active ? "var(--accent-500)" : "transparent",
              transition: "all 140ms ease",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
