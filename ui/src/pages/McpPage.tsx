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
// The commands, kickoff prompt, and tool names mirror doc/MCP-LAUNCH.md and
// packages/mcp-server/src/journey.ts (the canonical sources) — keep them in
// sync when the flow or tool surface changes.

import type { ReactNode } from "react";
import { MarketingShell } from "../marketing/MarketingShell";
import { SectionContainer } from "../marketing/components/SectionContainer";
import { Eyebrow } from "../marketing/components/Eyebrow";
import { Button } from "../marketing/components/Button";

const GITHUB_REPO_URL = "https://github.com/thetangstr/agentdash";

const CLONE_AND_BUILD = `git clone ${GITHUB_REPO_URL}.git ~/agentdash
cd ~/agentdash && pnpm install && pnpm --filter @agentdash/mcp-server build`;

// Fresh machine: no server, no user, no key — the unauthenticated journey
// tools (install checklist, setup status, sign-up) carry the whole claim.
const MCP_ADD_FRESH = `claude mcp add agentdash \\
  --env PAPERCLIP_API_URL=http://localhost:3100 \\
  -- node ~/agentdash/packages/mcp-server/dist/stdio.js`;

// Existing instance: point at its URL and pass the board API key that
// agentdash_sign_up returned (or one your workspace admin minted for you).
const MCP_ADD_EXISTING = `claude mcp add agentdash \\
  --env PAPERCLIP_API_URL=https://YOUR-INSTANCE:3100 \\
  --env PAPERCLIP_API_KEY=YOUR-BOARD-API-KEY \\
  -- node ~/agentdash/packages/mcp-server/dist/stdio.js`;

// The canonical kickoff prompt from doc/MCP-LAUNCH.md §3, with the
// MCP-native signup step: on a fresh install the agent signs the human up
// with their email — no browser form, no password.
const KICKOFF_PROMPT = `You are setting up AgentDash for a new customer on this machine. Read the
agentdash://playbook resource first.

Operating loop: call agentdash_setup_status, execute its nextAction, verify
the result, and repeat until the customer's company is provisioned and its
agents are running. If the server is not installed yet, follow
agentdash_install_checklist step by step. On a fresh install, sign me up
first with agentdash_sign_up — ask me for my email; never invent one.

Interview the customer conversationally (deep-interview) to understand their
business, goals, and constraints before confirming any plan. Use
agentdash_start_interview and agentdash_interview_turn; only call
agentdash_confirm_plan after the customer has explicitly agreed to the
proposed agent team.

BOUNDARIES:
- Never hire agents beyond the confirmed plan.
- Never delete anything or change budgets.
- Never resume agents a human has paused.
- For any such action, call agentdash_request_approval and WAIT for the
  approval to be granted in the AgentDash UI (/approvals). Do not proceed
  on a pending or rejected approval.
- If blocked for any other reason, stop and create a task for the human
  describing exactly what you need.`;

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
            The MCP server ships inside the AgentDash repo. Clone and build it
            once (needs Node 20+, pnpm 9+, and git):
          </p>
          <CodeBlock label="Step 1 — clone and build">{CLONE_AND_BUILD}</CodeBlock>
          <p style={{ margin: 0, color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
            <strong>Setting up a brand-new machine?</strong> Add the server
            with no API key — the install checklist, status, and sign-up tools
            work unauthenticated and walk your agent through first boot and
            claiming the instance:
          </p>
          <CodeBlock label="Step 2 — fresh machine (no account yet)">{MCP_ADD_FRESH}</CodeBlock>
          <p style={{ margin: 0, color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
            <strong>Connecting to a running AgentDash?</strong> Point at your
            instance URL and pass your board API key — the one
            <code> agentdash_sign_up</code> returned when the instance was
            claimed, or a key your workspace admin minted for you:
          </p>
          <CodeBlock label="Step 2 — existing instance">{MCP_ADD_EXISTING}</CodeBlock>
          <p style={{ margin: 0, color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
            Then start your agent and paste the kickoff prompt below. On an
            already-running workspace you can skip it and just talk —
            &ldquo;show me my dashboard&rdquo; is enough.
          </p>
          <CodeBlock label="Step 3 — the kickoff prompt">{KICKOFF_PROMPT}</CodeBlock>
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
