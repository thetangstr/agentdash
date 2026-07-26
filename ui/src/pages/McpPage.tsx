// AgentDash — PUBLIC MCP access page. No auth, no sidebar, no company context.
// Mounted OUTSIDE CloudAccessGate in ui/src/App.tsx at /mcp, the same public
// tier as /trial, /investors, and /pricing.
//
// Unlike PricingPage (standalone "Porcelain" Tailwind page), this page uses
// the marketing surface (MarketingShell + mkt-* tokens, like /consulting and
// /about): it is a product-marketing story — "AgentDash is MCP-native" — so
// it belongs on the cream marketing brand with the shared header/footer nav.
// No new CSS frameworks; everything below is the existing mkt-* system plus
// inline styles on mkt tokens, exactly like Consulting.tsx.
//
// The commands and tool names mirror doc/MCP-LAUNCH.md and
// packages/mcp-server/src/journey.ts (the canonical sources) — keep them in
// sync when the flow or tool surface changes. Deliberately NO kickoff prompt
// here: the server's protocol-level instructions steer the agent, and the
// operator runbook (doc/MCP-LAUNCH.md) is where the full prompt lives.

import type { ReactNode } from "react";
import { MarketingShell } from "../marketing/MarketingShell";
import { SectionContainer } from "../marketing/components/SectionContainer";
import { Eyebrow } from "../marketing/components/Eyebrow";
import { Button } from "../marketing/components/Button";

const GITHUB_REPO_URL = "https://github.com/thetangstr/agentdash";

// One command on a fresh Mac: scripts/bootstrap-fresh-mac.sh does prereq
// checks, clone, install, build, env defaults, and `claude mcp add`.
const BOOTSTRAP_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/thetangstr/agentdash/main/scripts/bootstrap-fresh-mac.sh | bash";

// Existing instance: point at its URL and pass the board API key that
// agentdash_sign_up returned (or one your workspace admin minted for you).
const MCP_ADD_EXISTING = `claude mcp add agentdash \\
  --env PAPERCLIP_API_URL=https://YOUR-INSTANCE:3100 \\
  --env PAPERCLIP_API_KEY=YOUR-BOARD-API-KEY \\
  -- node ~/agentdash/packages/mcp-server/dist/stdio.js`;

// No kickoff prompt on this page on purpose: the MCP server ships its own
// operating playbook and approval boundaries as protocol-level server
// instructions (packages/mcp-server/src/playbook.ts), so the customer just
// talks. The full operator runbook lives in doc/MCP-LAUNCH.md.
const FIRST_WORDS = `Set up AgentDash for me.`;

const HOW_IT_WORKS: Array<{ step: string; title: string; body: string }> = [
  {
    step: "01",
    title: "Install",
    body:
      "Add the AgentDash MCP server to Claude Code (or any MCP client) with one command. "
      + "No API key needed yet — the install checklist and status tools work unauthenticated.",
  },
  {
    step: "02",
    title: "Sign up via chat",
    body:
      "Your agent asks for your email in conversation and calls agentdash_sign_up. The server "
      + "creates your founding account and hands back an API key — no signup form, no password.",
  },
  {
    step: "03",
    title: "Deep interview",
    body:
      "The Chief of Staff interviews you about your business, goals, and constraints, then "
      + "proposes an agent team. Nothing is hired until you explicitly approve the plan.",
  },
  {
    step: "04",
    title: "Team runs with approval gates",
    body:
      "Your agents operate goal-oriented and self-driving — while hires, deletions, budget "
      + "changes, and anything outside the confirmed goals wait for your approval in the UI.",
  },
];

// Tool names mirror packages/mcp-server/src/journey.ts — the agentdash_*
// journey surface. Grouped by what a customer uses them for.
const TOOL_GROUPS: Array<{ title: string; blurb: string; tools: string[] }> = [
  {
    title: "Set up & claim",
    blurb: "Work before a server or account even exists — install, boot, and claim the instance.",
    tools: ["agentdash_install_checklist", "agentdash_setup_status", "agentdash_sign_up"],
  },
  {
    title: "Interview & plan",
    blurb: "The deep interview that turns your business context into a proposed agent team.",
    tools: [
      "agentdash_start_interview",
      "agentdash_interview_turn",
      "agentdash_get_plan",
      "agentdash_revise_plan",
      "agentdash_confirm_plan",
    ],
  },
  {
    title: "Operate your team",
    blurb: "Day-to-day control of a running workspace from any MCP client.",
    tools: [
      "agentdash_get_dashboard",
      "agentdash_list_agents",
      "agentdash_pause_agent",
      "agentdash_resume_agent",
      "agentdash_list_tasks",
      "agentdash_create_task",
    ],
  },
  {
    title: "Governance",
    blurb: "Risky actions stop here — requested over MCP, granted only by a human in the UI.",
    tools: ["agentdash_request_approval", "agentdash_check_approval"],
  },
];

function CodeBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure style={{ margin: 0 }}>
      <figcaption
        style={{
          fontSize: 12,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--mkt-ink-soft)",
          marginBottom: "var(--mkt-space-1)",
        }}
      >
        {label}
      </figcaption>
      <pre
        style={{
          margin: 0,
          padding: "var(--mkt-space-3)",
          background: "var(--mkt-ink)",
          color: "var(--mkt-surface-cream)",
          borderRadius: 12,
          fontSize: 13,
          lineHeight: 1.6,
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        <code>{children}</code>
      </pre>
    </figure>
  );
}

export function McpPage() {
  return (
    <MarketingShell>
      <SectionContainer>
        <Eyebrow>MCP-native</Eyebrow>
        <h1
          className="mkt-display-page"
          style={{ marginTop: 16, marginBottom: 32, maxWidth: "22ch" }}
        >
          Access AgentDash from any MCP client.
        </h1>
        <div style={{ display: "grid", gap: 24, maxWidth: "60ch", color: "var(--mkt-ink-soft)" }}>
          <p className="mkt-body-lg">
            No signup forms, no dashboards required. Connect the AgentDash MCP
            server to Claude Code, Claude Desktop, Cursor, or any MCP client,
            and your agent does the rest: it signs you up with your email,
            interviews you about your business, builds your agent team, and
            runs it day to day — with every risky action gated behind your
            approval.
          </p>
        </div>
      </SectionContainer>

      <SectionContainer background="cream-2">
        <h2 className="mkt-display-section" style={{ marginBottom: "var(--mkt-space-4)" }}>
          Get connected
        </h2>
        <div style={{ display: "grid", gap: "var(--mkt-space-4)", maxWidth: 760 }}>
          <p style={{ margin: 0, color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
            <strong>Setting up a brand-new machine?</strong> One command
            handles everything — prerequisites, install, build, and MCP
            registration (needs Node 20+ and the Claude Code CLI):
          </p>
          <CodeBlock label="Fresh machine — one command">{BOOTSTRAP_COMMAND}</CodeBlock>
          <p style={{ margin: 0, color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
            Then start your agent and just say:
          </p>
          <CodeBlock label={"That's it — the agent does the rest"}>{FIRST_WORDS}</CodeBlock>
          <p style={{ margin: 0, color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
            No prompt to paste. The AgentDash MCP server carries its own
            operating playbook and approval boundaries, so any connected agent
            already knows the drill: install if needed, sign you up with your
            email, interview you about your business, and propose an agent
            team — hiring nothing until you approve the plan.
          </p>
          <p style={{ margin: 0, color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
            <strong>Connecting to a running AgentDash?</strong> Point at your
            instance URL and pass your board API key — the one returned when
            the instance was claimed, or a key your workspace admin minted for
            you. Then just talk: &ldquo;show me my dashboard&rdquo; is enough.
          </p>
          <CodeBlock label="Existing instance">{MCP_ADD_EXISTING}</CodeBlock>
        </div>
      </SectionContainer>

      <SectionContainer>
        <h2 className="mkt-display-section" style={{ marginBottom: "var(--mkt-space-6)" }}>
          How it works
        </h2>
        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gap: "var(--mkt-space-3)",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          }}
        >
          {HOW_IT_WORKS.map((item) => (
            <li
              key={item.step}
              style={{
                border: "1px solid var(--mkt-rule)",
                borderRadius: 16,
                padding: "var(--mkt-space-3)",
                background: "var(--mkt-surface-cream)",
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 800,
                  color: "var(--mkt-accent)",
                  letterSpacing: "0.08em",
                  marginBottom: "var(--mkt-space-1)",
                }}
              >
                {item.step}
              </div>
              <h3 style={{ margin: 0, marginBottom: "var(--mkt-space-1)", fontSize: 18 }}>
                {item.title}
              </h3>
              <p style={{ margin: 0, color: "var(--mkt-ink-soft)", fontSize: 15, lineHeight: 1.55 }}>
                {item.body}
              </p>
            </li>
          ))}
        </ol>
      </SectionContainer>

      <SectionContainer background="cream-2">
        <h2 className="mkt-display-section" style={{ marginBottom: "var(--mkt-space-4)" }}>
          What your agent can do
        </h2>
        <p style={{ margin: 0, marginBottom: "var(--mkt-space-4)", color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
          Every AgentDash service is a tool your agent can call. The
          <code> agentdash_*</code> journey covers the whole lifecycle, and a
          full workspace toolset (issues, comments, documents, projects,
          approvals) handles the day-to-day work underneath.
        </p>
        <div
          style={{
            display: "grid",
            gap: "var(--mkt-space-3)",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          }}
        >
          {TOOL_GROUPS.map((group) => (
            <div
              key={group.title}
              style={{
                border: "1px solid var(--mkt-rule)",
                borderRadius: 16,
                padding: "var(--mkt-space-3)",
                background: "var(--mkt-surface-cream)",
              }}
            >
              <h3 style={{ margin: 0, marginBottom: "var(--mkt-space-1)", fontSize: 18 }}>
                {group.title}
              </h3>
              <p style={{ margin: 0, marginBottom: "var(--mkt-space-2)", color: "var(--mkt-ink-soft)", fontSize: 15, lineHeight: 1.55 }}>
                {group.blurb}
              </p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                {group.tools.map((tool) => (
                  <li key={tool}>
                    <code
                      style={{
                        fontSize: 13,
                        background: "var(--mkt-surface-cream-2)",
                        border: "1px solid var(--mkt-rule)",
                        borderRadius: 6,
                        padding: "2px 8px",
                      }}
                    >
                      {tool}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </SectionContainer>

      <SectionContainer>
        <div style={{ textAlign: "center", display: "grid", gap: "var(--mkt-space-3)", justifyItems: "center" }}>
          <h2 className="mkt-display-section" style={{ margin: 0 }}>
            Ready when your agent is.
          </h2>
          <p style={{ margin: 0, color: "var(--mkt-ink-soft)", maxWidth: "52ch" }}>
            AgentDash is open source. Free for one human and one agent — see
            pricing for teams.
          </p>
          <div style={{ display: "flex", gap: "var(--mkt-space-2)", flexWrap: "wrap", justifyContent: "center" }}>
            <Button href="/pricing">See pricing</Button>
            <Button href={GITHUB_REPO_URL} variant="ghost">View on GitHub</Button>
          </div>
        </div>
      </SectionContainer>
    </MarketingShell>
  );
}
