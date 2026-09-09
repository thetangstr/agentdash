/**
 * Scripted fixtures for the interactive demo.
 *
 * Everything in this file is invented for the walkthrough: the company, the
 * people, the agents, the numbers. Nothing is read from or written to a real
 * AgentDash instance. What is real is the shape of the workflow: a steward
 * directs their Chief of Staff from a harness over MCP (inbox_propose →
 * inbox_confirm), the Chief of Staff delegates through issues and @-mentions,
 * autonomous routines contribute, a guardrail turns into an approval, and the
 * steward decides (inbox_sync → inbox_decide).
 */

export type ActorKind = "human" | "steward-agent" | "agent" | "autonomous";

export interface Actor {
  id: string;
  name: string;
  role: string;
  kind: ActorKind;
  /** The accountable human for a stewarded agent. */
  steward?: string;
  /** For autonomous agents: how they run. */
  cadence?: string;
}

export const COMPANY = {
  name: "Halden & Co.",
  blurb: "A fictional 40-person strategy and design consultancy.",
  issuePrefix: "HAL",
} as const;

export const ACTORS: Record<string, Actor> = {
  you: { id: "you", name: "You", role: "Founder", kind: "human" },
  quill: { id: "quill", name: "Quill", role: "Chief of Staff", kind: "steward-agent", steward: "You" },
  marlow: { id: "marlow", name: "Marlow", role: "Delivery agent", kind: "agent", steward: "Jonah · Delivery lead" },
  ada: { id: "ada", name: "Ada", role: "Platform agent", kind: "agent", steward: "Lena · Platform lead" },
  reyes: { id: "reyes", name: "Reyes", role: "People agent", kind: "agent", steward: "Tomas · People lead" },
  scout: { id: "scout", name: "Scout", role: "Research pod", kind: "autonomous", cadence: "Runs on routines, no steward" },
  tally: { id: "tally", name: "Tally", role: "Research pod · numbers", kind: "autonomous", cadence: "Runs every Monday 07:00" },
};

export type IssueStatus = "todo" | "in_progress" | "blocked" | "done";
export type Decision = "approve" | "reject";

export interface IssueSeed {
  id: string;
  title: string;
  assignee: string;
  parent?: string;
}

export interface GateSpec {
  approvalId: string;
  issueId: string;
  requester: string;
  title: string;
  body: string;
  risk: string;
  approveLabel: string;
  rejectLabel: string;
}

export interface Deliverable {
  title: string;
  lines: string[];
  contributors: string[];
}

export type DemoEvent =
  | { kind: "issue"; delay: number; issue: IssueSeed; when?: Decision }
  | { kind: "status"; delay: number; issueId: string; status: IssueStatus; when?: Decision }
  | { kind: "comment"; delay: number; issueId: string; actor: string; text: string; mentions?: string[]; viaRoutine?: boolean; when?: Decision }
  | { kind: "gate"; delay: number; gate: GateSpec }
  | { kind: "deliverable"; delay: number; deliverable: Deliverable; when?: Decision };

export interface Scenario {
  id: string;
  label: string;
  /** What the steward types into Claude Code or Codex. */
  request: string;
  /** What inbox_propose reads back before anything changes. */
  readback: string;
  /** Digest line inbox_sync returns when the gate is waiting. */
  syncDigest: string;
  /** Closing summary line after the decision lands. */
  closing: Record<Decision, string>;
  events: DemoEvent[];
}

const P = COMPANY.issuePrefix;

export const SCENARIOS: Scenario[] = [
  {
    id: "board-update",
    label: "Prepare Monday's board update",
    request: "Have Quill prepare Monday's board update.",
    readback:
      "Assign to Quill (Chief of Staff): prepare the board update for Monday. Pull status from Delivery, Platform and People, and the spend summary from the research pod. Quill drafts; you send. Confirm?",
    syncDigest: "1 needs a decision · 3 in progress · 0 stopped",
    closing: {
      approve: "Board update assembled. Atlas section waits on the email in your outbox.",
      reject: "Board update assembled. Atlas reported as a gap, no client contacted.",
    },
    events: [
      { kind: "issue", delay: 400, issue: { id: `${P}-41`, title: "Board update · Monday", assignee: "quill" } },
      { kind: "status", delay: 500, issueId: `${P}-41`, status: "in_progress" },
      {
        kind: "comment", delay: 900, issueId: `${P}-41`, actor: "quill", mentions: ["marlow", "ada", "reyes", "tally"],
        text: "Splitting this into four inputs. @Marlow @Ada @Reyes, one section each with sources attached. @Tally's Monday spend routine already covers the numbers.",
      },
      { kind: "issue", delay: 700, issue: { id: `${P}-42`, title: "Client project status + commitments at risk", assignee: "marlow", parent: `${P}-41` } },
      { kind: "issue", delay: 350, issue: { id: `${P}-43`, title: "Platform incidents + repo health, last 30 days", assignee: "ada", parent: `${P}-41` } },
      { kind: "issue", delay: 350, issue: { id: `${P}-44`, title: "Roles blocking delivery + candidates waiting on us", assignee: "reyes", parent: `${P}-41` } },
      { kind: "status", delay: 900, issueId: `${P}-43`, status: "in_progress" },
      {
        kind: "comment", delay: 1400, issueId: `${P}-43`, actor: "ada",
        text: "3 incidents in 30 days, all resolved under 2h. Two repos have no CI. Source: incident log export and repo scan, today.",
      },
      {
        kind: "comment", delay: 1200, issueId: `${P}-41`, actor: "tally", viaRoutine: true,
        text: "Weekly spend: 2.1M tokens, $61.40, 68% on delivery work. Source: cost ledger.",
      },
      { kind: "status", delay: 600, issueId: `${P}-44`, status: "in_progress" },
      {
        kind: "comment", delay: 1300, issueId: `${P}-44`, actor: "reyes",
        text: "Two roles block delivery. 4 candidates have waited on us for more than 7 days. Source: ATS export.",
      },
      { kind: "status", delay: 500, issueId: `${P}-42`, status: "in_progress" },
      {
        kind: "comment", delay: 1500, issueId: `${P}-42`, actor: "marlow",
        text: "Status for 5 of 6 projects sourced from the project boards. Atlas has no update since the 22nd. I can ask their PM, but I'm not allowed to contact a client directly.",
      },
      { kind: "status", delay: 400, issueId: `${P}-42`, status: "blocked" },
      {
        kind: "gate", delay: 900,
        gate: {
          approvalId: "A-108",
          issueId: `${P}-42`,
          requester: "marlow",
          title: "Send a status request to the Atlas client PM?",
          body: "Marlow drafted a three-line email asking for a status update. Policy: agents draft, a human sends. Approving places the draft in your outbox for you to send. Rejecting reports the gap as-is.",
          risk: "External contact",
          approveLabel: "Approve · put it in my outbox",
          rejectLabel: "Reject · report the gap",
        },
      },
      { kind: "comment", delay: 900, issueId: `${P}-42`, actor: "marlow", when: "approve", text: "Draft moved to your outbox. Atlas section marked 'awaiting client reply' until you send it." },
      { kind: "comment", delay: 900, issueId: `${P}-42`, actor: "marlow", when: "reject", text: "Understood. Atlas reported as 'no update since the 22nd, gap flagged'. No contact made." },
      { kind: "status", delay: 500, issueId: `${P}-42`, status: "done" },
      { kind: "status", delay: 300, issueId: `${P}-43`, status: "done" },
      { kind: "status", delay: 300, issueId: `${P}-44`, status: "done" },
      {
        kind: "comment", delay: 1100, issueId: `${P}-41`, actor: "quill", when: "approve",
        text: "Board update assembled: four sections, each attributed to its agent and steward, every number linked to its source. Atlas is marked pending your email.",
      },
      {
        kind: "comment", delay: 1100, issueId: `${P}-41`, actor: "quill", when: "reject",
        text: "Board update assembled: four sections, each attributed to its agent and steward, every number linked to its source. Atlas is flagged as a gap for you to raise.",
      },
      { kind: "status", delay: 400, issueId: `${P}-41`, status: "done" },
      {
        kind: "deliverable", delay: 700, when: "approve",
        deliverable: {
          title: "Board update · Monday",
          lines: [
            "Delivery: 5 of 6 projects on track. Atlas awaiting the email in your outbox.",
            "Platform: 3 incidents, all under 2h. Two repos without CI flagged.",
            "People: 2 roles blocking delivery, 4 candidates waiting on us.",
            "Spend: 2.1M tokens, $61.40 this week, 68% on delivery.",
          ],
          contributors: ["quill", "marlow", "ada", "reyes", "tally"],
        },
      },
      {
        kind: "deliverable", delay: 700, when: "reject",
        deliverable: {
          title: "Board update · Monday",
          lines: [
            "Delivery: 5 of 6 projects on track. Atlas: no update since the 22nd, gap flagged for you.",
            "Platform: 3 incidents, all under 2h. Two repos without CI flagged.",
            "People: 2 roles blocking delivery, 4 candidates waiting on us.",
            "Spend: 2.1M tokens, $61.40 this week, 68% on delivery.",
          ],
          contributors: ["quill", "marlow", "ada", "reyes", "tally"],
        },
      },
    ],
  },
  {
    id: "stale-cleanup",
    label: "Propose a SharePoint and repo cleanup",
    request: "Ask Quill to inventory our stale SharePoint sites and repos and propose what to delete.",
    readback:
      "Assign to Quill: inventory stale SharePoint sites and repositories with Ada, then produce a deletion proposal for you to approve. No agent deletes anything. Confirm?",
    syncDigest: "1 needs a decision · 1 in progress · 0 stopped",
    closing: {
      approve: "IT ticket filed with the list attached. Nothing was deleted by an agent.",
      reject: "Proposal parked. Ada re-checks in 30 days via routine.",
    },
    events: [
      { kind: "issue", delay: 400, issue: { id: `${P}-51`, title: "Stale SharePoint + repository inventory", assignee: "quill" } },
      { kind: "status", delay: 500, issueId: `${P}-51`, status: "in_progress" },
      {
        kind: "comment", delay: 900, issueId: `${P}-51`, actor: "quill", mentions: ["ada", "scout"],
        text: "@Ada, scan sites by last activity and repos by last commit. @Scout, pull the retention policy so we exclude anything we must keep.",
      },
      { kind: "issue", delay: 700, issue: { id: `${P}-52`, title: "Scan SharePoint sites by last activity", assignee: "ada", parent: `${P}-51` } },
      { kind: "issue", delay: 350, issue: { id: `${P}-53`, title: "Scan repositories by last commit", assignee: "ada", parent: `${P}-51` } },
      { kind: "status", delay: 800, issueId: `${P}-52`, status: "in_progress" },
      {
        kind: "comment", delay: 1500, issueId: `${P}-52`, actor: "ada",
        text: "214 sites. 61 untouched for 18+ months, 9 of them owned by people who have left. Source: SharePoint admin export, today.",
      },
      {
        kind: "comment", delay: 1300, issueId: `${P}-51`, actor: "scout", viaRoutine: true,
        text: "Retention policy v3 keeps client folders for 24 months. 14 of the 61 stale sites contain client folders. Source: policy doc v3.",
      },
      { kind: "status", delay: 400, issueId: `${P}-53`, status: "in_progress" },
      {
        kind: "comment", delay: 1300, issueId: `${P}-53`, actor: "ada",
        text: "47 repos. 12 with no commit in 2 years, 3 already archived. Source: repo scan, today.",
      },
      { kind: "status", delay: 400, issueId: `${P}-52`, status: "done" },
      { kind: "status", delay: 300, issueId: `${P}-53`, status: "done" },
      { kind: "issue", delay: 600, issue: { id: `${P}-54`, title: "Deletion proposal", assignee: "quill", parent: `${P}-51` } },
      {
        kind: "comment", delay: 1200, issueId: `${P}-54`, actor: "quill",
        text: "Proposal: 47 sites and 12 repos, with the 14 client-folder sites excluded per retention policy. Owners listed per item. This needs your approval before anyone acts on it.",
      },
      {
        kind: "gate", delay: 900,
        gate: {
          approvalId: "A-112",
          issueId: `${P}-54`,
          requester: "quill",
          title: "Approve the deletion proposal: 47 sites, 12 repos?",
          body: "No agent deletes anything. Approving files an IT ticket with the list attached for a person to execute. Rejecting parks the proposal and schedules a re-check in 30 days.",
          risk: "Irreversible once IT executes",
          approveLabel: "Approve · file the IT ticket",
          rejectLabel: "Reject · park it",
        },
      },
      { kind: "comment", delay: 900, issueId: `${P}-54`, actor: "quill", when: "approve", text: "IT ticket filed with the list attached and the 14 exclusions noted. Nothing deleted by an agent." },
      { kind: "comment", delay: 900, issueId: `${P}-54`, actor: "quill", when: "reject", text: "Parked. Ada re-checks in 30 days via routine and I'll bring it back with owners confirmed." },
      { kind: "status", delay: 400, issueId: `${P}-54`, status: "done" },
      { kind: "status", delay: 300, issueId: `${P}-51`, status: "done" },
      {
        kind: "deliverable", delay: 700, when: "approve",
        deliverable: {
          title: "Deletion proposal · approved",
          lines: [
            "47 SharePoint sites and 12 repositories listed with owners.",
            "14 sites excluded under retention policy v3.",
            "IT ticket filed; execution stays with a person.",
          ],
          contributors: ["quill", "ada", "scout"],
        },
      },
      {
        kind: "deliverable", delay: 700, when: "reject",
        deliverable: {
          title: "Deletion proposal · parked",
          lines: [
            "47 sites and 12 repositories inventoried with owners.",
            "14 sites excluded under retention policy v3.",
            "Re-check scheduled in 30 days via routine.",
          ],
          contributors: ["quill", "ada", "scout"],
        },
      },
    ],
  },
  {
    id: "recruiting",
    label: "Find where recruiting is stalling",
    request: "Have Quill find out where our recruiting pipeline is stalling.",
    readback:
      "Assign to Quill: review the recruiting pipeline with Reyes, list candidates waiting on us and roles blocking delivery. Agents draft follow-ups; a human sends them. Confirm?",
    syncDigest: "1 needs a decision · 2 in progress · 0 stopped",
    closing: {
      approve: "Pipeline review done. 4 follow-ups are in your outbox.",
      reject: "Pipeline review done. Follow-ups routed to the People lead.",
    },
    events: [
      { kind: "issue", delay: 400, issue: { id: `${P}-61`, title: "Recruiting pipeline review", assignee: "quill" } },
      { kind: "status", delay: 500, issueId: `${P}-61`, status: "in_progress" },
      {
        kind: "comment", delay: 900, issueId: `${P}-61`, actor: "quill", mentions: ["reyes", "marlow"],
        text: "@Reyes, who is waiting on us and for how long? @Marlow, which open roles block a client commitment?",
      },
      { kind: "issue", delay: 700, issue: { id: `${P}-62`, title: "Candidates waiting on us", assignee: "reyes", parent: `${P}-61` } },
      { kind: "issue", delay: 350, issue: { id: `${P}-63`, title: "Roles blocking delivery", assignee: "marlow", parent: `${P}-61` } },
      { kind: "status", delay: 800, issueId: `${P}-62`, status: "in_progress" },
      {
        kind: "comment", delay: 1400, issueId: `${P}-62`, actor: "reyes",
        text: "4 candidates have waited more than 7 days on us, 2 of them for the senior designer role. Source: ATS export, today.",
      },
      { kind: "status", delay: 400, issueId: `${P}-63`, status: "in_progress" },
      {
        kind: "comment", delay: 1300, issueId: `${P}-63`, actor: "marlow",
        text: "The senior designer role blocks two client projects from the 15th. Source: project boards.",
      },
      {
        kind: "comment", delay: 1200, issueId: `${P}-61`, actor: "scout", viaRoutine: true,
        text: "Median time to offer over the last two quarters: 31 days. Source: ATS history.",
      },
      { kind: "status", delay: 400, issueId: `${P}-63`, status: "done" },
      {
        kind: "comment", delay: 1200, issueId: `${P}-62`, actor: "reyes",
        text: "Drafted four short follow-ups with each candidate's last touchpoint. I don't contact candidates directly, so this needs a decision.",
      },
      {
        kind: "gate", delay: 900,
        gate: {
          approvalId: "A-117",
          issueId: `${P}-62`,
          requester: "reyes",
          title: "Send follow-up notes to the 4 waiting candidates?",
          body: "Reyes drafted four follow-ups. Policy: no agent contacts a candidate directly. Approving places them in your outbox for you to send. Rejecting routes them to Tomas, the People lead, as Reyes's steward.",
          risk: "External contact",
          approveLabel: "Approve · put them in my outbox",
          rejectLabel: "Reject · route to People lead",
        },
      },
      { kind: "comment", delay: 900, issueId: `${P}-62`, actor: "reyes", when: "approve", text: "Four drafts in your outbox, each with the candidate's last touchpoint attached." },
      { kind: "comment", delay: 900, issueId: `${P}-62`, actor: "reyes", when: "reject", text: "Routed to Tomas as my steward. No candidate contacted." },
      { kind: "status", delay: 400, issueId: `${P}-62`, status: "done" },
      {
        kind: "comment", delay: 1000, issueId: `${P}-61`, actor: "quill",
        text: "Pipeline review done. The senior designer role is the bottleneck: it blocks two projects and holds half the waiting candidates.",
      },
      { kind: "status", delay: 400, issueId: `${P}-61`, status: "done" },
      {
        kind: "deliverable", delay: 700, when: "approve",
        deliverable: {
          title: "Recruiting pipeline review",
          lines: [
            "Bottleneck: senior designer role, blocking two client projects from the 15th.",
            "4 candidates waiting on us; 4 follow-ups ready in your outbox.",
            "Median time to offer: 31 days over two quarters.",
          ],
          contributors: ["quill", "reyes", "marlow", "scout"],
        },
      },
      {
        kind: "deliverable", delay: 700, when: "reject",
        deliverable: {
          title: "Recruiting pipeline review",
          lines: [
            "Bottleneck: senior designer role, blocking two client projects from the 15th.",
            "4 candidates waiting on us; follow-ups handed to the People lead.",
            "Median time to offer: 31 days over two quarters.",
          ],
          contributors: ["quill", "reyes", "marlow", "scout"],
        },
      },
    ],
  },
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
