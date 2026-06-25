#!/usr/bin/env node
// AgentDash: seed a populated MSP "tier-1 ticket triage" demo company.
//
// Creates one MSP company, a Chief of Staff + a Ticket Triage agent (both left
// PAUSED so they never spawn heartbeat runs on a live box), and a populated
// board of support tickets with Definitions of Done — two already resolved with
// passing verdicts, one in progress, two in the backlog — so a fresh viewer sees
// real agent-driven outcomes, not an empty workspace.
//
// Usage:
//   AGENTDASH_BASE_URL=https://host AGENTDASH_BOARD_KEY=pcp_board_... \
//     node scripts/seed/demo-msp-company.mjs
//
// Env:
//   AGENTDASH_BASE_URL    default http://localhost:3100
//   AGENTDASH_BOARD_KEY   board bearer token (required unless local_trusted mode)
//   AGENTDASH_SEED_ADAPTER default "hermes_local" (the managed-Hermes runtime)
//   AGENTDASH_SEED_NAME    default "Northwind MSP"

const BASE = (process.env.AGENTDASH_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const BOARD_KEY = process.env.AGENTDASH_BOARD_KEY ?? "";
const ADAPTER = process.env.AGENTDASH_SEED_ADAPTER ?? "hermes_local";
const COMPANY_NAME = process.env.AGENTDASH_SEED_NAME ?? "Northwind MSP";

const headers = {
  "content-type": "application/json",
  ...(BOARD_KEY ? { authorization: `Bearer ${BOARD_KEY}` } : {}),
};

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    if (res.status === 402) {
      throw new Error(
        `402 tier cap hit on ${method} ${path}. Set AGENTDASH_BILLING_DISABLED=true or raise the cap, then retry. Body: ${text.slice(0, 200)}`,
      );
    }
    throw new Error(`${res.status} ${method} ${path} -> ${typeof json === "string" ? json : JSON.stringify(json)}`);
  }
  return json;
}

function dod(summary, criteria) {
  return { summary, criteria: criteria.map((text, i) => ({ id: String(i + 1), text, done: false })) };
}

const TICKETS = [
  {
    title: "Email service outage — ~50 users cannot send/receive",
    description: "Exchange Online connectivity dropped at 10:32. Multiple clients reporting bounce-backs.",
    priority: "critical",
    status: "done",
    resolved: true,
    dod: dod("Mail flow restored and verified for all affected users", [
      "SMTP/IMAP responding from two external probes",
      "All 50 affected mailboxes send + receive a test message",
      "No NDR/bounce errors in the last 15 min of logs",
      "Five end-users spot-checked and confirm working",
    ]),
  },
  {
    title: "Security: suspicious logins on 3 admin accounts",
    description: "Impossible-travel sign-ins flagged by the SIEM overnight from two new geos.",
    priority: "critical",
    status: "done",
    resolved: true,
    dod: dod("Incident contained, credentials rotated, scope confirmed", [
      "Affected sessions revoked + passwords rotated",
      "MFA re-enrolled on the 3 accounts",
      "Audit log reviewed for lateral movement (none found)",
      "Client notified with a short incident summary",
    ]),
  },
  {
    title: "VPN drops for remote staff after the firmware update",
    description: "~12 remote users report VPN re-connect loops since last night's gateway update.",
    priority: "high",
    status: "in_progress",
    resolved: false,
    dod: dod("All remote users hold a stable tunnel for >30 min", [
      "Root cause identified (MTU / IKE rekey)",
      "Fix applied to the gateway config",
      "12 affected users confirm a stable session",
    ]),
  },
  {
    title: "Password-reset request backlog (queue at 23)",
    description: "Self-service portal degraded; tier-1 reset queue building up since morning.",
    priority: "medium",
    status: "backlog",
    resolved: false,
    dod: dod("Reset queue cleared and self-service restored", [
      "All 23 pending resets completed",
      "Self-service portal verified working",
    ]),
  },
  {
    title: "Nightly backup job failing for 3 consecutive nights",
    description: "Veeam job for the file server exits with a repository write error.",
    priority: "medium",
    status: "backlog",
    resolved: false,
    dod: dod("Backups green and a restore test passes", [
      "Repository write error resolved",
      "Two consecutive nightly jobs complete",
      "Test restore of one file set verified",
    ]),
  },
];

async function main() {
  console.log(`Seeding "${COMPANY_NAME}" against ${BASE} (adapter=${ADAPTER}, auth=${BOARD_KEY ? "board-key" : "none/local_trusted"})`);

  const company = await api("POST", "/api/companies", {
    name: COMPANY_NAME,
    description: "Managed service provider — tier-1 ticket triage demo workspace.",
    budgetMonthlyCents: 0,
  });
  console.log(`  company ${company.id} (${company.issuePrefix ?? "?"})`);

  async function agent(name, role, title, capabilities, reportsTo) {
    const a = await api("POST", `/api/companies/${company.id}/agents`, {
      name,
      role,
      title,
      capabilities,
      reportsTo: reportsTo ?? null,
      adapterType: ADAPTER,
      adapterConfig: {},
      budgetMonthlyCents: 0,
    });
    // Leave it PAUSED so it never spawns a heartbeat run on a live box.
    await api("PATCH", `/api/agents/${a.id}`, { status: "paused" }).catch(() => undefined);
    console.log(`  agent ${a.id} ${name} (paused)`);
    return a;
  }

  const cos = await agent("Avery (CoS)", "chief_of_staff", "Chief of Staff", "Coordinates the MSP desk, reviews outcomes, escalates to humans.", null);
  const triage = await agent("Tier-1 Triage", "general", "Ticket Triage Agent", "Triages inbound tickets: classify, prioritize, resolve or route, draft first responses.", cos.id);

  for (const t of TICKETS) {
    const issue = await api("POST", `/api/companies/${company.id}/issues`, {
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      assigneeAgentId: triage.id,
      definitionOfDone: t.dod,
    });
    console.log(`  issue ${issue.identifier ?? issue.id} [${t.status}] ${t.title.slice(0, 48)}`);
    if (t.resolved) {
      await api("POST", `/api/companies/${company.id}/verdicts`, {
        entityType: "issue",
        issueId: issue.id,
        outcome: "passed",
        reviewerAgentId: cos.id,
        justification: "All DoD criteria met and spot-checked by the CoS review.",
        rubricScores: { completeness: 5, quality: 5, timeliness: 4 },
      }).catch((e) => console.log(`    (verdict skipped: ${e.message.slice(0, 80)})`));
    }
  }

  console.log(`\nDone. Open ${BASE} → company "${COMPANY_NAME}" to see the populated triage board.`);
}

main().catch((err) => {
  console.error(`\nSeed failed: ${err.message}`);
  process.exit(1);
});
// Re-running this script creates a NEW company each time; delete the prior demo company first if re-seeding.
