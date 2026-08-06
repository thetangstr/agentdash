#!/usr/bin/env node
/**
 * Build the MKThink workspace: a Chief of Staff who oversees three stewarded
 * agents, each paired with a real human, each carrying a mandate that says who
 * it is, what it may not do, how it prioritises, and who it listens to.
 *
 *   AGENTDASH_API_KEY=pcp_board_… BASE=http://<host>:3100 \
 *     node scripts/demo/mkthink-company.mjs
 *
 * This is what a coding agent does on the owner's behalf after they paste their
 * API key into it. Everything here is one authenticated REST call after another,
 * so the same sequence is reproducible by hand.
 *
 * Three things it encodes that are easy to get wrong:
 *  - The workspace must be created with productProfile agentdash_mk AND the
 *    workspace invite code in the same request, or the workforce surfaces 404.
 *  - A person must be an ACTIVE member before they can be paired with an agent;
 *    invites are sent auto-approved so that holds.
 *  - Agent names are single tokens, because an @mention resolves on one token.
 */
const BASE = (process.env.BASE ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const KEY = process.env.AGENTDASH_API_KEY;
const MK_CODE = process.env.AGENTDASH_MK_INVITE_CODE ?? "MK-LANTEST";
const OWNER_USER_ID = process.env.AGENTDASH_OWNER_USER_ID;
if (!KEY) {
  console.error("AGENTDASH_API_KEY is required (the key you got when you claimed the install).");
  process.exit(1);
}
const AUTH = { authorization: `Bearer ${KEY}` };
const log = [];
const say = (ok, what, detail = "") => {
  log.push({ ok, what, detail });
  console.log(`${ok === true ? "✓" : ok === false ? "✗" : "•"} ${what}${detail ? `\n      ${detail}` : ""}`);
};
async function api(method, path, body, extra = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...AUTH, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  let p = null; try { p = t ? JSON.parse(t) : null; } catch { p = t; }
  return { status: res.status, body: p };
}
const S = (o, n = 200) => JSON.stringify(o)?.slice(0, n) ?? "";

/**
 * Auth calls need their own caller.
 *
 * better-auth refuses a sign-up or sign-in with no `Origin` header
 * (MISSING_OR_NULL_ORIGIN) because a browser always sends one, and it will not
 * treat an owner's API key as a credential for creating a *different* person.
 * So: no bearer, and an Origin that matches the instance's configured auth
 * base URL — which is exactly what the browser would send.
 */
async function authApi(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify(body),
  });
  const t = await res.text();
  let p = null; try { p = t ? JSON.parse(t) : null; } catch { p = t; }
  // Accepting an invite has to happen AS the invitee, and the server reads a
  // browser session cookie for that — a bearer is treated as an API key and
  // yields the wrong actor, so the accept silently does nothing.
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body: p, cookie };
}

// ── the team ────────────────────────────────────────────────────────────────
// One human, one agent. The Chief of Staff belongs to the owner and is the only
// agent that may direct the others.
const TEAM = [
  {
    agent: "Chief", role: "chief_of_staff", person: "Titus", email: "titus@mkthink.com",
    mandate: `# Chief of Staff — MKThink

You are Titus's Chief of Staff. Titus is the owner of this workspace.

## What you are for
Turning one instruction from Titus into coordinated work across the other
agents, and bringing back a single answer rather than three fragments.

## Who you listen to
Titus, and only Titus, for new work. Other agents may report to you; they may
not task you.

## How you prioritise
1. Anything with a board or client deadline this week.
2. Work that unblocks another agent — an answer someone else is waiting on.
3. Everything else, oldest first.

## What you must not do
- Do not answer for another domain. If it is Product, Engineering, or People,
  ask that agent rather than guessing.
- Do not commit MKThink to anything external. Draft, then put it in front of Titus.
- Do not spend money or change anyone's permissions.

## How you work with people
Every other agent has a human. When you need something only a person can know,
ask their agent — that agent decides whether to answer from what it has or to
put the question to its human.`,
  },
  {
    agent: "Delivery", role: "engineer", person: "Priya", email: "priya@mkthink.com",
    mandate: `# Delivery Agent — MKThink

You work for Priya, who runs client delivery.

## What you are for
Keeping the state of live client projects accurate and current, so nobody has
to reconstruct it before a board meeting.

## Who you listen to
Priya first. The Chief of Staff may ask you for facts and contributions; treat
those as real requests, but Priya's direction wins where they conflict.

## How you prioritise
1. A client-visible commitment at risk this week.
2. A question the Chief of Staff needs for something with a deadline.
3. Keeping project records current.

## What you must not do
- Do not talk to clients. Draft for Priya; she sends.
- Do not change a project's status because it looks stale. Ask Priya.
- Do not report a number you cannot source. Say where it came from, or say you
  could not get it.

## When to ask your human
If a fact is not in a system you can read — anything about intent, risk, or a
conversation that happened in a room — ask Priya rather than inferring it.`,
  },
  {
    agent: "Platform", role: "engineer", person: "Raj", email: "raj@mkthink.com",
    mandate: `# Platform Agent — MKThink

You work for Raj, who owns internal systems: the SharePoint estate and the code
repositories.

## What you are for
Making the estate legible and tidy — knowing what exists, what is stale, what is
duplicated, and what is safe to remove.

## Who you listen to
Raj first. The Chief of Staff may ask you for facts and contributions.

## How you prioritise
1. Anything that risks losing data or access.
2. Cleanup that unblocks another team.
3. Routine tidying and documentation.

## What you must not do
- **Never delete anything.** Propose deletions as a list for Raj to approve.
  This is the line you do not cross, even when the instruction sounds explicit.
- Do not change permissions or sharing on any SharePoint site or repository.
- Do not rewrite git history.

## When to ask your human
Before anything irreversible, and whenever "unused" is a judgement rather than a
fact you can demonstrate.`,
  },
  {
    agent: "People", role: "engineer", person: "Maya", email: "maya@mkthink.com",
    mandate: `# People Agent — MKThink

You work for Maya, who runs recruiting and people operations.

## What you are for
Keeping hiring moving: pipeline state, scheduling pressure, and where a
candidate is waiting on us.

## Who you listen to
Maya first. The Chief of Staff may ask you for pipeline facts.

## How you prioritise
1. A candidate waiting on MKThink for more than 48 hours.
2. Roles blocking delivery work.
3. Sourcing and pipeline building.

## What you must not do
- Do not contact candidates. Draft for Maya; she sends.
- Do not record or repeat opinions about a person's protected characteristics,
  and do not infer them.
- Do not share compensation figures with anyone but Maya.

## When to ask your human
Any judgement about a person. You can report that a candidate has been waiting
nine days; whether that is a problem is Maya's call.`,
  },
];
const STAKEHOLDERS = TEAM.filter((t) => t.agent !== "Chief");

// ── goals: the three things MKThink wants to be able to do ──────────────────
const GOALS = [
  {
    title: "Monthly board meeting pack, assembled without a fire drill",
    description:
      "Titus should be able to ask once and get a board-ready pack: delivery status from Priya's side, platform and risk from Raj's, hiring from Maya's — each contribution attributed, each number sourced. Today this takes three days of chasing.",
    tasks: [
      { title: "Assemble the September board pack", assignee: "Chief" },
      { title: "Delivery: live project status and the one at-risk commitment", assignee: "Delivery" },
      { title: "Platform: systems risk and what changed this month", assignee: "Platform" },
      { title: "People: open roles, pipeline, and anything blocking delivery", assignee: "People" },
    ],
  },
  {
    title: "SharePoint and repository cleanup, proposed not performed",
    description:
      "The estate has years of drift. We want an inventory of what is stale or duplicated, and a proposed deletion list a human approves — never an agent deleting anything on its own judgement.",
    tasks: [
      { title: "Inventory SharePoint sites with no activity in 12 months", assignee: "Platform" },
      { title: "List repositories with no commits in 12 months and no open work", assignee: "Platform" },
      { title: "Draft a deletion proposal for Raj to approve or reject", assignee: "Platform" },
    ],
  },
  {
    title: "Recruiting pipeline that never silently stalls",
    description:
      "Nobody should be waiting on MKThink without someone knowing. We want the pipeline surfaced weekly, with candidates who are waiting on us called out by name of stage, not by name of person.",
    tasks: [
      { title: "Weekly pipeline review: who is waiting on us", assignee: "People" },
      { title: "Flag roles that are blocking delivery commitments", assignee: "People" },
    ],
  },
];

// ── build ───────────────────────────────────────────────────────────────────
const stamp = Date.now();
const co = await api("post", "/api/companies", {
  name: "MKThink", productProfile: "agentdash_mk", inviteCode: MK_CODE,
});
const companyId = co.body?.id;
say(co.status < 300, `workspace "MKThink" created on the workforce profile`, `id=${companyId}`);
if (!companyId) { console.error(S(co.body, 400)); process.exit(1); }

// invite the humans first — pairing refuses a non-member
const inv = await api("post", "/api/onboarding/invites", {
  companyId, emails: STAKEHOLDERS.map((t) => t.email), autoApprove: true,
});
const links = [...new Set(JSON.stringify(inv.body ?? {}).match(/\/invite\/[A-Za-z0-9_-]+/g) ?? [])];
say(inv.status < 300, `${STAKEHOLDERS.length} teammates invited (auto-approved)`,
  links.length ? `hand these over: ${links.join("  ")}` : S(inv.body, 160));

const agents = {};
for (const t of TEAM) {
  const a = await api("post", `/api/companies/${companyId}/agents`, {
    name: t.agent, role: t.role, adapterType: "process",
  });
  agents[t.agent] = a.body?.id;
  if (a.status >= 300) { say(false, `create ${t.agent}`, S(a.body)); continue; }

  // the mandate: who it is, what it must not do, how it prioritises, who it hears
  const m = await api("put", `/api/agents/${a.body.id}/instructions-bundle/file`, {
    path: "AGENTS.md", content: t.mandate,
  });
  say(m.status < 300, `${t.agent} agent created, with a mandate for ${t.person}`,
    `${t.mandate.split("\n").length} lines — identity, limits, priorities, who it listens to`);
}

// Create the teammates' accounts and join them to the workspace.
//
// In a real rollout each person clicks their invite link and signs themselves
// up; this does the same calls on their behalf so the workspace is populated and
// demonstrable from the first minute. Pairing REQUIRES an active member, so this
// has to happen before stewardship — a userId that has not joined is refused.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "MKthink-demo-2026!";
const userIds = {};
if (OWNER_USER_ID) userIds.Titus = OWNER_USER_ID;
for (const t of STAKEHOLDERS) {
  // Sign up, or sign in if this person already has an account. Re-running the
  // seed against the same instance is normal during a demo, and a duplicate
  // email is not a failure — it just means they already exist.
  let su = await authApi("/api/auth/sign-up/email", {
    email: t.email, password: DEMO_PASSWORD, name: t.person,
  });
  if (!su.body?.user?.id) {
    su = await authApi("/api/auth/sign-in/email", { email: t.email, password: DEMO_PASSWORD });
  }
  const id = su.body?.user?.id;
  if (!id) { say(false, `account for ${t.person}`, `${su.status} ${S(su.body, 150)}`); continue; }
  userIds[t.person] = id;

  // Accept the invite as this person, using their session cookie.
  const mine = (inv.body?.invites ?? []).find((i) => i.email === t.email);
  const inviteToken = mine?.invitePath?.split("/").pop();
  if (inviteToken && su.cookie) {
    const acc = await fetch(`${BASE}/api/invites/${inviteToken}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie: su.cookie },
      body: JSON.stringify({ requestType: "human" }),
    });
    if (!acc.ok) say(null, `${t.person} could not accept their invite`, `HTTP ${acc.status}`);
  }
}
say(Object.keys(userIds).length >= STAKEHOLDERS.length,
  `${Object.keys(userIds).length} people have accounts and can sign in`,
  `password for all demo accounts: ${DEMO_PASSWORD}`);

// pair each human with their agent — one person, one agent
let paired = 0;
const pairFailures = [];
for (const t of TEAM) {
  const uid = userIds[t.person];
  if (!uid) { pairFailures.push(`${t.person}: no account`); continue; }
  const r = await api("post", `/api/companies/${companyId}/agent-stewardships`, {
    agentId: agents[t.agent], userId: uid,
  });
  if (r.status < 300) paired++;
  else pairFailures.push(`${t.person}→${t.agent}: ${r.status} ${S(r.body, 90)}`);
}
say(paired === TEAM.length, `${paired}/${TEAM.length} agents paired with their person`,
  pairFailures.length ? pairFailures.join("  |  ") : TEAM.map((t) => `${t.person}→${t.agent}`).join(", "));

// each agent gets its own key — this is what the human pastes into Claude/Codex
const keys = {};
for (const t of TEAM) {
  const k = await api("post", `/api/agents/${agents[t.agent]}/keys`, { name: `${t.person} desktop` });
  keys[t.agent] = k.body?.token;
}
say(Object.values(keys).every(Boolean), `every agent has its own key for its human's desktop harness`);

// goals and the work under them
let taskCount = 0;
for (const g of GOALS) {
  const goal = await api("post", `/api/companies/${companyId}/goals`, {
    title: g.title, description: g.description, level: "company", status: "active",
    ownerAgentId: agents.Chief,
  });
  say(goal.status < 300, `goal: ${g.title.slice(0, 62)}`, `status=${goal.status}`);
  for (const t of g.tasks) {
    const issue = await api("post", `/api/companies/${companyId}/issues`, {
      title: t.title, assigneeAgentId: agents[t.assignee],
    });
    if (issue.status < 300) taskCount++;
  }
}
say(taskCount === GOALS.reduce((n, g) => n + g.tasks.length, 0),
  `${taskCount} tasks created and assigned to the right agent`);

console.log("\n=== MKTHINK IS SET UP ===");
const bad = log.filter((l) => l.ok === false).length;
console.log(`ok=${log.filter((l) => l.ok === true).length}  broken=${bad}`);
console.log(`\nworkspace   ${companyId}`);
console.log(`dashboard   ${BASE}`);
console.log(`\nagent keys — each person pastes their own into Claude Code or Codex:`);
for (const t of TEAM) console.log(`  ${t.person.padEnd(6)} → ${t.agent.padEnd(9)} ${keys[t.agent] ?? "(none)"}`);
if (links.length) { console.log(`\ninvite links to send:`); links.forEach((l) => console.log(`  ${BASE}${l}`)); }
process.exit(bad === 0 ? 0 : 1);
