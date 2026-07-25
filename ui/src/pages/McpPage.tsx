// AgentDash — PUBLIC MCP setup page. No auth, no sidebar, no company context.
// Mounted OUTSIDE CloudAccessGate in ui/src/App.tsx at /mcp, the same public
// tier as /trial, /investors, and /pricing.
//
// Unlike PricingPage (standalone "Porcelain" Tailwind page), this page uses
// the marketing surface (MarketingShell + mkt-* tokens, like /consulting and
// /about): it is a product-marketing story — "set up AgentDash from your
// terminal" — so it belongs on the cream marketing brand with the shared
// header/footer nav. No new CSS frameworks; everything below is the existing
// mkt-* system plus inline styles on mkt tokens, exactly like Consulting.tsx.
//
// The copy-paste command and kickoff prompt mirror doc/MCP-LAUNCH.md (the
// canonical runbook) — keep the two in sync when the flow changes.

import type { ReactNode } from "react";
import { MarketingShell } from "../marketing/MarketingShell";
import { SectionContainer } from "../marketing/components/SectionContainer";
import { Eyebrow } from "../marketing/components/Eyebrow";
import { Button } from "../marketing/components/Button";

const GITHUB_REPO_URL = "https://github.com/thetangstr/agentdash";

const MCP_ADD_COMMAND = `claude mcp add agentdash \\
  --env PAPERCLIP_API_URL=https://YOUR-INSTANCE:3100 \\
  -- node <repo>/packages/mcp-server/dist/stdio.js`;

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
        <Eyebrow>MCP-native setup</Eyebrow>
        <h1
          className="mkt-display-page"
          style={{ marginTop: 16, marginBottom: 32, maxWidth: "20ch" }}
        >
          Set up AgentDash from your terminal.
        </h1>
        <div style={{ display: "grid", gap: 24, maxWidth: "60ch", color: "var(--mkt-ink-soft)" }}>
          <p className="mkt-body-lg">
            No signup forms. Connect the AgentDash MCP server to your coding
            agent, and it does the rest: it signs you up with your email, interviews
            you about your business, and builds your agent team — with every risky
            action gated behind your approval.
          </p>
        </div>
      </SectionContainer>

      <SectionContainer background="cream-2">
        <h2 className="mkt-display-section" style={{ marginBottom: "var(--mkt-space-4)" }}>
          One command to connect
        </h2>
        <div style={{ display: "grid", gap: "var(--mkt-space-4)", maxWidth: 760 }}>
          <CodeBlock label="Add the MCP server to Claude Code">{MCP_ADD_COMMAND}</CodeBlock>
          <p style={{ margin: 0, color: "var(--mkt-ink-soft)", maxWidth: "60ch" }}>
            Point <code>PAPERCLIP_API_URL</code> at your AgentDash instance. On a
            fresh install you don&apos;t need an API key — your agent signs you up
            and mints one in the first conversation.
          </p>
          <CodeBlock label="Then paste this kickoff prompt">{KICKOFF_PROMPT}</CodeBlock>
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
