#!/usr/bin/env node
// The AgentDash-MK demo, end to end, against a running server.
//
//   pnpm demo:board-deck            # against http://127.0.0.1:3100
//   BASE=http://host:3100 pnpm demo:board-deck
//
// It sets up a workspace the way a customer would have one, then runs the whole
// board-deck loop and prints the deck:
//
//   Titus asks his agent for a board deck
//     → that agent calls the Product, Engineering and Marketing agents
//     → each of those escalates to ITS OWN human's laptop over the bridge
//     → each human answers from their machine
//     → each agent returns its answer, attributed
//     → the chief agent consolidates and posts the deck
//
// Three things this script encodes that are easy to get wrong, each found by
// running it rather than by reading the code:
//
//  1. Assigning a steward is refused unless that person is an ACTIVE company
//     member (services/agent-stewardships.ts). There is no HTTP route to add a
//     member — production goes through invites — so the seed inserts membership.
//  2. `escalate` resolves the answering agent's steward and then looks for bridge
//     endpoints belonging to THAT steward's userId. `/me/bridge/endpoints` always
//     binds to the calling user, and in local_trusted every request is the same
//     synthetic user, so distinct humans need the service called directly.
//  3. An @mention resolves on a SINGLE token matched against the agent's name
//     (packages/shared/src/mention-parser.ts). An agent called "product agent"
//     can never be reached as @product, so the agents here are named in one word.
const BASE = (process.env.BASE ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const log = [];
const say = (ok, what, detail = "") => {
  log.push({ ok, what, detail });
  console.log(`${ok === true ? "✓" : ok === false ? "✗" : "•"} ${what}${detail ? `\n      ${detail}` : ""}`);
};
async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const S = (o, n = 200) => JSON.stringify(o)?.slice(0, n) ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AGENT = (key) => ({ "x-agent-key": key });          // an agent's own credential
const MACHINE = (token) => ({ authorization: `Bearer ${token}` }); // a human's own machine

// Single-token agent names so `@Product` resolves; one chief_of_staff so an
// un-addressed message has someone to answer it.
const TEAM = [
  { agent: "Chief", role: "chief_of_staff", human: "titus", person: "Titus" },
  { agent: "Product", role: "engineer", human: "priya", person: "Priya" },
  { agent: "Engineering", role: "engineer", human: "raj", person: "Raj" },
  { agent: "Marketing", role: "engineer", human: "maya", person: "Maya" },
];
const STAKEHOLDERS = TEAM.filter((t) => t.agent !== "Chief");
const personOf = (agent) => TEAM.find((t) => t.agent === agent);

const health = await api("get", "/api/health");
if (health.status !== 200) {
  console.error(`Server is not answering at ${BASE} (health ${health.status}). Start it with \`pnpm dev\` first.`);
  process.exit(1);
}

// ── the workspace ───────────────────────────────────────────────────────────
const stamp = Date.now();
const company = await api("post", "/api/companies", { name: `Board Deck Demo ${stamp}`, productProfile: "agentdash_mk" });
const companyId = company.body?.id;
say(company.status < 300, `workspace created on the agentdash_mk profile`, `id=${companyId}`);
if (!companyId) process.exit(1);

const agents = {};
for (const t of TEAM) {
  const a = await api("post", `/api/companies/${companyId}/agents`, { name: t.agent, role: t.role, adapterType: "process" });
  agents[t.agent] = a.body?.id;
  if (a.status >= 300) say(false, `create the ${t.agent} agent`, `${a.status} ${S(a.body)}`);
}
say(Object.values(agents).every(Boolean), `${TEAM.length} agents created`, TEAM.map((t) => t.agent).join(", "));

// ── the humans: membership + a machine each (must precede stewardship) ──────
const { execFileSync } = await import("node:child_process");
let endpoints = [];
try {
  const out = execFileSync("npx",
    ["pnpm@9.15.4", "--filter", "@paperclipai/server", "exec", "tsx", "scripts/mkthink-demo-endpoints.ts",
      ...TEAM.map((t) => t.human)],
    { cwd: REPO, env: { ...process.env, DEMO_COMPANY_ID: companyId }, encoding: "utf8" });
  endpoints = JSON.parse(out.slice(out.indexOf("[")));
} catch (e) { say(false, `seed the humans and their machines`, String(e.message).slice(0, 300)); }
const machineOf = (human) => endpoints.find((e) => e.userId === human);
say(endpoints.length === TEAM.length, `${endpoints.length} humans are members, each with an enrolled machine`,
  endpoints.map((e) => `${personOf(TEAM.find((t) => t.human === e.userId)?.agent)?.person ?? e.userId}`).join(", "));

let paired = 0;
for (const t of TEAM) {
  const r = await api("post", `/api/companies/${companyId}/agent-stewardships`, { agentId: agents[t.agent], userId: t.human });
  if (r.status < 300) paired++; else say(false, `pair ${t.person} with the ${t.agent} agent`, `${r.status} ${S(r.body)}`);
}
say(paired === TEAM.length, `${paired}/${TEAM.length} people paired with an agent`,
  TEAM.map((t) => `${t.person}→${t.agent}`).join(", ") + `  (one person, one agent)`);

const keys = {};
for (const t of TEAM) keys[t.agent] = (await api("post", `/api/agents/${agents[t.agent]}/keys`, { name: "demo" })).body?.token;
say(Object.values(keys).every(Boolean), `each agent has its own credential`);

// ── a human talks to an agent ───────────────────────────────────────────────
console.log("\n--- a human talks to their agent ---");
const inbox = await api("get", `/api/conversations/companies/${companyId}/inbox`);
const convId = inbox.body?.id;
say(inbox.status === 200 && !!convId, `Titus opens the company conversation`, `conversation=${convId}`);
const sent = await api("post", `/api/conversations/${convId}/messages`, {
  companyId, body: "@Product what should the board know about product this week?" });
say(sent.status < 300, `Titus addresses the Product agent by name`, `status=${sent.status}`);
await sleep(2500);
const thread = await api("get", `/api/conversations/${convId}/messages?limit=20`);
const msgs = thread.body?.messages ?? thread.body ?? [];
const replied = msgs.filter((m) => m.role === "agent");
say(replied.length >= 1, `the agent replies in the thread`,
  replied.length ? `"${String(replied[0].content ?? "").slice(0, 90)}"` : `no reply`);
if (replied.some((m) => /stub/i.test(String(m.content ?? "")))) {
  say(null, `replies are STUB text`, `the conversation path works; the words need a model — set ANTHROPIC_API_KEY or use claude_local`);
}

// ── the ask, and the call to three agents ──────────────────────────────────
console.log("\n--- Titus asks for the board deck ---");
const parent = await api("post", `/api/companies/${companyId}/issues`, { title: "Board meeting deck", assigneeAgentId: agents.Chief });
const parentId = parent.body?.id;
say(parent.status < 300, `the Chief agent opens "Board meeting deck"`, `item=${parentId}`);

const runId = `deck-${stamp}`;
const asks = {};
for (const t of STAKEHOLDERS) {
  const factKey = `${t.agent.toLowerCase()}_status`;
  const ask = await api("post", `/api/companies/${companyId}/fact-requests`, {
    targetAgentId: agents[t.agent], factKey, runId, pipelineId: "board_deck",
    question: `What should the board know about ${t.agent.toLowerCase()} this week?`,
  }, AGENT(keys.Chief));
  asks[t.agent] = { id: ask.body?.id, factKey };
  say(ask.status < 300, `asks the ${t.agent} agent for "${factKey}"`, `status=${ask.status}`);
}

// ── each agent checks with its own human ───────────────────────────────────
console.log("\n--- each agent checks with its human, over the bridge ---");
for (const t of STAKEHOLDERS) {
  const esc = await api("post", `/api/companies/${companyId}/fact-requests/${asks[t.agent].id}/escalate`, {}, AGENT(keys[t.agent]));
  const st = esc.body?.status ?? esc.body?.factRequest?.status;
  say(esc.status < 300 && st === "escalated", `the ${t.agent} agent reaches ${t.person}'s laptop`, `status=${st}`);
}

// ── the humans answer from their own machines ──────────────────────────────
console.log("\n--- the humans answer from their own machines ---");
const answers = {};
for (const t of STAKEHOLDERS) {
  const machine = machineOf(t.human);
  if (!machine) { say(false, `${t.person} has no machine enrolled`); continue; }
  const poll = await api("post", "/api/bridge/poll", {}, MACHINE(machine.token));
  const task = poll.body?.task;
  if (!task) { say(false, `${t.person}'s machine polled and got nothing`, S(poll.body, 160)); continue; }
  say(true, `${t.person}'s machine receives the question`, `"${String(task.instruction ?? "").slice(0, 80)}"`);
  const text = `${t.person} on ${t.agent.toLowerCase()}: the two numbers that moved this week, and the one risk the board should hear.`;
  const sub = await api("post", "/api/bridge/result",
    { taskId: task.id, resultToken: poll.body.resultToken, result: text }, MACHINE(machine.token));
  if (sub.status < 300) answers[t.agent] = text;
  say(sub.status < 300, `${t.person} answers from their machine`, `outcome=${sub.body?.outcome}`);
}

// ── the agents hand the answers back, attributed ───────────────────────────
console.log("\n--- the agents hand the answers back ---");
for (const t of STAKEHOLDERS) {
  if (!answers[t.agent]) continue;
  const ans = await api("post", `/api/companies/${companyId}/fact-requests/${asks[t.agent].id}/answer`,
    { answer: answers[t.agent], sourceKind: "human" }, AGENT(keys[t.agent]));
  say(ans.status < 300, `the ${t.agent} agent answers the Chief agent`, `status=${ans.status}`);
}

// ── consolidation ──────────────────────────────────────────────────────────
console.log("\n--- consolidation ---");
const back = await api("get", `/api/companies/${companyId}/fact-requests?role=requester`, undefined, AGENT(keys.Chief));
const rows = back.body?.factRequests ?? [];
const answered = rows.filter((r) => r.answer);
say(answered.length === STAKEHOLDERS.length, `the Chief agent reads back ${answered.length}/${rows.length} answers`,
  rows.map((r) => `${r.factKey}=${r.status}`).join(" "));
const deck = `BOARD MEETING DECK (draft)\n\n${answered.map((a) => `## ${a.factKey}\n${a.answer}\n`).join("\n")}`;
const posted = await api("post", `/api/issues/${parentId}/comments`, { body: deck });
say(posted.status < 300 && answered.length === STAKEHOLDERS.length, `the deck is posted on the board item`, `chars=${deck.length}`);

// ── report ─────────────────────────────────────────────────────────────────
const ok = log.filter((l) => l.ok === true).length;
const broken = log.filter((l) => l.ok === false).length;
const notes = log.filter((l) => l.ok === null).length;
console.log(`\n=== ${broken === 0 ? "DEMO PASSED" : "DEMO INCOMPLETE"} ===`);
console.log(`ok=${ok}  broken=${broken}  notes=${notes}`);
if (broken) { console.log("\nbroken:"); log.filter((l) => l.ok === false).forEach((l) => console.log(`  ✗ ${l.what}\n      ${l.detail}`)); }
if (answered.length === STAKEHOLDERS.length) console.log(`\n${deck}`);
console.log(`\nworkspace=${companyId}\nboardItem=${parentId}\ndashboard=${BASE}`);
process.exit(broken === 0 ? 0 : 1);
