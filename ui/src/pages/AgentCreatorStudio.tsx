// AgentDash: agent-creator studio.
// Phase 0 — avatar A/B spike. Renders both aesthetic treatments side-by-side
// over interactive sample equip state so we can pick the default treatment
// before building the full wizard. No backend.
import { useState, type CSSProperties } from "react";
import { AgentAvatar } from "../components/agent-creator/avatar/AgentAvatar";
import { AvatarVariantSwitch } from "../components/agent-creator/avatar/AvatarVariantSwitch";
import type {
  AvatarRiskLevel,
  AvatarSlotId,
  AvatarVariant,
  EquippedAvatarItem,
} from "../components/agent-creator/avatar/avatar-geometry";
import { getAgentIcon } from "../lib/agent-icons";
import { useFeatureFlags } from "../hooks/useFeatureFlag";
import { ALL_AVATAR_VARIANTS, AVATAR_VARIANT_FLAG_KEYS } from "../lib/feature-flags";

interface SampleModule {
  id: string;
  label: string;
  slot: AvatarSlotId;
  risk: AvatarRiskLevel;
}

// Illustrative catalog for the spike — real catalog (bound to connectors /
// skills / budget) lands in Phase 2.
const SAMPLE_MODULES: SampleModule[] = [
  { id: "eng", label: "Engineering", slot: "head", risk: "high" },
  { id: "strategy", label: "Strategy", slot: "head", risk: "low" },
  { id: "finance", label: "Finance", slot: "tools", risk: "high" },
  { id: "comms", label: "Comms", slot: "tools", risk: "medium" },
  { id: "data", label: "Data & web", slot: "environment", risk: "medium" },
  { id: "crm", label: "CRM", slot: "environment", risk: "low" },
  { id: "ops", label: "Operations", slot: "body", risk: "low" },
  { id: "support", label: "Support", slot: "body", risk: "none" },
];

const ICON_CHOICES = ["bot", "brain", "rocket", "telescope", "shield", "gem"];

const RISK_LABEL: Record<AvatarRiskLevel, string> = {
  none: "safe",
  low: "low",
  medium: "medium",
  high: "high",
};
const RISK_COLOR: Record<AvatarRiskLevel, string> = {
  none: "var(--success-500)",
  low: "var(--info-500)",
  medium: "var(--warn-500)",
  high: "var(--danger-500)",
};

export function AgentCreatorStudio() {
  const [equippedIds, setEquippedIds] = useState<string[]>(["strategy", "ops"]);
  const [securityOn, setSecurityOn] = useState(true);
  const [iconName, setIconName] = useState("bot");
  const [focusVariant, setFocusVariant] = useState<AvatarVariant | null>(null);

  // Each avatar treatment is gated by its own per-company feature flag.
  const { isLoading: flagsLoading, isEnabled } = useFeatureFlags();
  const availableVariants = ALL_AVATAR_VARIANTS.filter((v) =>
    isEnabled(AVATAR_VARIANT_FLAG_KEYS[v]),
  );

  const equipped: EquippedAvatarItem[] = SAMPLE_MODULES.filter((m) =>
    equippedIds.includes(m.id),
  ).map((m) => ({ slotId: m.slot, moduleId: m.id, label: m.label, risk: m.risk }));

  const coverage = Math.min(100, equipped.length * 16 + (securityOn ? 8 : 0));

  const toggle = (id: string) =>
    setEquippedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  // Render the focused variant if it is enabled, else all enabled variants.
  const variants: AvatarVariant[] =
    focusVariant && availableVariants.includes(focusVariant)
      ? [focusVariant]
      : availableVariants;

  if (flagsLoading) {
    return <div style={{ padding: "var(--space-8)", color: "var(--text-secondary)" }}>Loading…</div>;
  }

  if (availableVariants.length === 0) {
    return <AvatarFlagsEmptyState />;
  }

  return (
    <div
      style={{
        padding: "var(--space-8)",
        maxWidth: 1100,
        margin: "0 auto",
        color: "var(--text-primary)",
      }}
    >
      <div style={{ marginBottom: "var(--space-2)" }}>
        <div
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 10,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
          }}
        >
          Agent creator · avatar spike
        </div>
        <h1
          style={{
            fontFamily: "var(--font-serif, Georgia, serif)",
            fontSize: "var(--text-3xl)",
            margin: "var(--space-1) 0 0",
            fontWeight: 400,
          }}
        >
          Two treatments, one figure
        </h1>
        <p style={{ color: "var(--text-secondary)", maxWidth: 620, marginTop: "var(--space-2)" }}>
          Equip sample capabilities below and compare the restrained, on-brand
          treatment against the game-energy treatment. Both share identical slot
          geometry. Pick the one to take forward.
        </p>
      </div>

      {availableVariants.length === 2 ? (
        <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", margin: "var(--space-6) 0 var(--space-4)" }}>
          <AvatarVariantSwitch
            value={focusVariant ?? "restrained"}
            onChange={(v) => setFocusVariant(v)}
          />
          <button
            onClick={() => setFocusVariant(null)}
            style={ghostBtn(focusVariant === null)}
          >
            Show both
          </button>
        </div>
      ) : (
        <div style={{ margin: "var(--space-6) 0 var(--space-4)", fontSize: "var(--text-sm)", color: "var(--text-tertiary)" }}>
          One treatment enabled via feature flag. Enable the other flag to compare both.
        </div>
      )}

      {/* avatars */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: variants.length === 2 ? "1fr 1fr" : "1fr",
          gap: "var(--space-6)",
          marginBottom: "var(--space-8)",
        }}
      >
        {variants.map((variant) => (
          <div key={variant} style={card()}>
            <div style={cardEyebrow()}>
              {variant === "restrained" ? "Restrained · on-brand" : "Game-creator energy"}
            </div>
            <div style={{ display: "grid", placeItems: "center", padding: "var(--space-6) 0" }}>
              <AgentAvatar
                variant={variant}
                iconName={iconName}
                equipped={equipped}
                securityOn={securityOn}
                coverage={coverage}
                size={240}
              />
            </div>
            <CapabilityBar coverage={coverage} />
          </div>
        ))}
      </div>

      {/* controls */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-6)" }}>
        <div style={card()}>
          <div style={cardEyebrow()}>Equip capabilities</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
            {SAMPLE_MODULES.map((m) => {
              const on = equippedIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => toggle(m.id)}
                  aria-pressed={on}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 12px",
                    borderRadius: "var(--radius-pill)",
                    fontSize: "var(--text-sm)",
                    cursor: "pointer",
                    border: `1px solid ${on ? "var(--accent-500)" : "var(--border-soft)"}`,
                    background: on ? "var(--accent-50)" : "var(--surface-raised)",
                    color: "var(--text-primary)",
                    transition: "all 140ms ease",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: RISK_COLOR[m.risk],
                    }}
                  />
                  {m.label}
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
                    {RISK_LABEL[m.risk]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div style={card()}>
          <div style={cardEyebrow()}>Identity & guardrails</div>
          <div style={{ marginTop: "var(--space-3)" }}>
            <div style={fieldLabel()}>Head glyph</div>
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
              {ICON_CHOICES.map((name) => {
                const Icon = getAgentIcon(name);
                const on = iconName === name;
                return (
                  <button
                    key={name}
                    onClick={() => setIconName(name)}
                    aria-pressed={on}
                    aria-label={name}
                    style={{
                      display: "grid",
                      placeItems: "center",
                      width: 36,
                      height: 36,
                      borderRadius: "var(--radius-md)",
                      cursor: "pointer",
                      border: `1px solid ${on ? "var(--accent-500)" : "var(--border-soft)"}`,
                      background: on ? "var(--accent-50)" : "var(--surface-raised)",
                    }}
                  >
                    <Icon width={18} height={18} color="var(--text-primary)" />
                  </button>
                );
              })}
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                marginTop: "var(--space-4)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={securityOn}
                onChange={(e) => setSecurityOn(e.target.checked)}
              />
              <span style={{ fontSize: "var(--text-sm)" }}>
                Guardrails on (the shield)
              </span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

function AvatarFlagsEmptyState() {
  return (
    <div style={{ padding: "var(--space-8)", maxWidth: 720, margin: "0 auto", color: "var(--text-primary)" }}>
      <div style={cardEyebrow()}>Agent creator · avatar spike</div>
      <h1
        style={{
          fontFamily: "var(--font-serif, Georgia, serif)",
          fontSize: "var(--text-2xl)",
          fontWeight: 400,
          margin: "var(--space-1) 0 var(--space-3)",
        }}
      >
        No avatar treatment is enabled
      </h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: "var(--space-4)" }}>
        Both avatar treatments are behind per-company feature flags and are off by
        default. Enable one or both to preview them here:
      </p>
      <div style={{ ...card(), padding: "var(--space-4)" }}>
        {ALL_AVATAR_VARIANTS.map((v) => (
          <div
            key={v}
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
              padding: "2px 0",
            }}
          >
            {AVATAR_VARIANT_FLAG_KEYS[v]}{" "}
            <span style={{ color: "var(--text-tertiary)" }}>· {v}</span>
          </div>
        ))}
      </div>
      <p style={{ color: "var(--text-tertiary)", fontSize: "var(--text-xs)", marginTop: "var(--space-3)" }}>
        PUT /api/companies/&lt;companyId&gt;/feature-flags/&lt;flagKey&gt; with{" "}
        <code>{`{ "enabled": true }`}</code>
      </p>
    </div>
  );
}

function CapabilityBar({ coverage }: { coverage: number }) {
  return (
    <div style={{ marginTop: "var(--space-2)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "var(--text-xs)",
          color: "var(--text-tertiary)",
          marginBottom: 4,
        }}
      >
        <span>Capability coverage</span>
        <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{coverage}%</span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: "var(--radius-pill)",
          background: "var(--surface-sunken)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${coverage}%`,
            height: "100%",
            background: "var(--accent-500)",
            transition: "width 220ms ease",
          }}
        />
      </div>
    </div>
  );
}

function card(): CSSProperties {
  return {
    background: "var(--surface-raised)",
    border: "1px solid var(--border-soft)",
    borderRadius: "var(--radius-lg)",
    padding: "var(--space-6)",
    boxShadow: "var(--shadow-sm)",
  };
}
function cardEyebrow(): CSSProperties {
  return {
    fontFamily: "var(--font-mono, monospace)",
    fontSize: 10,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: "var(--text-tertiary)",
  };
}
function fieldLabel(): CSSProperties {
  return { fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-2)" };
}
function ghostBtn(active: boolean): CSSProperties {
  return {
    padding: "4px 12px",
    fontSize: "var(--text-sm)",
    borderRadius: "var(--radius-pill)",
    cursor: "pointer",
    border: `1px solid ${active ? "var(--accent-500)" : "var(--border-soft)"}`,
    background: active ? "var(--accent-50)" : "transparent",
    color: "var(--text-secondary)",
  };
}
