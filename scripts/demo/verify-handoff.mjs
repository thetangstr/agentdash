#!/usr/bin/env node
/**
 * Verify that the handoff brief in first-run.mjs is actually executable.
 *
 *   AGENTDASH_API_KEY=pcp_board_… BASE=http://host:3100 COMPANY_ID=<uuid> \
 *     node scripts/demo/verify-handoff.mjs
 *
 * Why this exists: stage 4 of first-run.mjs hands a person's coding agent a
 * brief full of concrete HTTP calls. Nothing tested those calls, and four of
 * them were wrong at once — a missing `pipelineId`, a `sourceKind` outside the
 * enum, an invite field that does not exist, and a reassignment step with no
 * endpoint at all. Each one fails in a way that reads as the agent's mistake
 * rather than the brief's, which is the worst possible place to put a typo:
 * the person following it has no way to know the instructions are the bug.
 *
 * So every call the brief names is executed here against a live instance. If
 * the API shape moves, this goes red instead of the customer's first session.
 *
 * It creates a throwaway agent and a throwaway invite; run it against a test
 * instance, not a live workspace.
 */
const BASE = (process.env.BASE ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const KEY = process.env.AGENTDASH_API_KEY;
const COMPANY_ID = process.env.COMPANY_ID;
if (!KEY || !COMPANY_ID) {
  console.error("AGENTDASH_API_KEY and COMPANY_ID are required.");
  process.exit(1);
}

const BASE_IS_LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/i.test(BASE);

let ok = 0;
let broken = 0;
const say = (good, what, detail = "") => {
  console.log(`  ${good ? "✓" : "✗"} ${what}${detail ? `   ${detail}` : ""}`);
  good ? ok++ : broken++;
};

/**
 * `extra` headers win over the owner bearer. An agent-only route called with
 * the owner's key refuses, so a bearer added unconditionally would make every
 * agent-acting step fail with a permission error that hides the real cause.
 */
async function api(method, path, body, extra = {}) {
  const res = await fetch(`${BASE}${path}`, {
    // Uppercased deliberately: undici normalises the common verbs but passes a
    // lowercase "patch" through, which the router does not match — it answered
    // 400 on a request that is correct in every other respect.
    method: method.toUpperCase(),
    headers: {
      ...(extra["x-agent-key"] ? {} : { authorization: `Bearer ${KEY}` }),
      ...(body ? { "content-type": "application/json" } : {}),
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const mintKey = async (agentId, name) => {
  const r = await api("post", `/api/agents/${agentId}/keys`, { name });
  // The field is `token`. `key` and `apiKey` are both absent, and reading one
  // yields undefined, which later fails as "Agent authentication required".
  return r.body?.token ?? null;
};

console.log(`\nverifying the handoff brief against ${BASE}\n`);

// ── the agents the brief tells the harness to create ──────────────────────
const agentsRes = await api("get", `/api/companies/${COMPANY_ID}/agents`);
const agents = Array.isArray(agentsRes.body) ? agentsRes.body : (agentsRes.body?.agents ?? []);
const chief = agents.find((a) => /chief/i.test(a.name)) ?? agents[0];
if (!chief) {
  console.error(`No agents in company ${COMPANY_ID} (status ${agentsRes.status}). Run first-run.mjs first.`);
  process.exit(1);
}

console.log("── step 2/3 · create an agent and write its mandate ──");
const made = await api("post", `/api/companies/${COMPANY_ID}/agents`, {
  name: "Verify",
  role: "engineer",
  adapterType: "process",
});
const agentId = made.body?.id;
say(made.status === 201 && !!agentId, "POST /companies/:id/agents", `${made.status}`);

const wrote = await api("put", `/api/agents/${agentId}/instructions-bundle/file`, {
  path: "AGENTS.md",
  content: "# Verify\n\nThrowaway agent from verify-handoff.mjs.",
});
say(wrote.status === 200, "PUT /agents/:id/instructions-bundle/file", `${wrote.status}`);

const readBack = await api(
  "get",
  `/api/agents/${agentId}/instructions-bundle/file?path=${encodeURIComponent("AGENTS.md")}`,
);
const mandate = readBack.body?.content ?? readBack.body?.file?.content ?? "";
say(readBack.status === 200 && mandate.includes("Verify"), "mandate reads back", `${readBack.status}`);

console.log("\n── step 4 · invite a teammate ──");
const stamp = Math.abs(Number(process.hrtime.bigint() % 100000n));
const invited = await api("post", "/api/onboarding/invites", {
  companyId: COMPANY_ID,
  emails: [`verify-${stamp}@example.invalid`],
  autoApprove: true,
});
const invite = invited.body?.invites?.[0];
say(
  invited.status < 300 && !!invite?.inviteUrl,
  "POST /onboarding/invites → inviteUrl",
  `${invited.status}`,
);
if (invite?.inviteUrl) {
  // Loopback links are only a defect when the caller had a routable address to
  // use. Verifying against 127.0.0.1 is normal, so this warns rather than fails
  // — otherwise the check that matters for a LAN deployment gets muted as noise.
  const loopback = /(127\.0\.0\.1|localhost)/i.test(invite.inviteUrl);
  if (loopback && BASE_IS_LOOPBACK) {
    console.log(
      `  ! invite link is loopback, matching this run's BASE   ${invite.inviteUrl}` +
        `\n    against a LAN instance this must show the LAN address, or teammates get a dead link`,
    );
  } else {
    say(!loopback, "invite link is shareable", invite.inviteUrl);
  }
}

console.log("\n── step 5 · pairing is refused before acceptance ──");
const early = await api("post", `/api/companies/${COMPANY_ID}/agent-stewardships`, {
  agentId,
  userId: "00000000-0000-0000-0000-000000000001",
});
say(early.status === 409, "pairing a non-member is refused with 409", `${early.status} ${early.body?.error ?? ""}`);

console.log("\n── step 6 · per-agent keys ──");
const chiefKey = await mintKey(chief.id, "verify chief");
const agentKey = await mintKey(agentId, "verify peer");
say(!!chiefKey && !!agentKey, "POST /agents/:id/keys returns `token`", chiefKey ? `${chiefKey.slice(0, 12)}…` : "no token");

console.log("\n── step 7 · reassign a task ──");
const issues = await api("get", `/api/companies/${COMPANY_ID}/issues`);
const list = Array.isArray(issues.body) ? issues.body : (issues.body?.issues ?? []);
say(Array.isArray(issues.body), "GET /companies/:id/issues returns a bare array", `${list.length} issues`);
if (list[0]) {
  const moved = await api("patch", `/api/issues/${list[0].id}`, { assigneeAgentId: agentId });
  const after = await api("get", `/api/companies/${COMPANY_ID}/issues`);
  const afterList = Array.isArray(after.body) ? after.body : (after.body?.issues ?? []);
  const stuck = afterList.find((i) => i.id === list[0].id)?.assigneeAgentId === agentId;
  say(moved.status === 200 && stuck, "PATCH /issues/:id reassigns and persists", `${moved.status}`);
}

console.log("\n── step 8 · the agent-to-agent loop ──");
const asked = await api(
  "post",
  `/api/companies/${COMPANY_ID}/fact-requests`,
  {
    targetAgentId: agentId,
    factKey: `verify_${stamp}`,
    runId: `verify-run-${stamp}`,
    pipelineId: "verify",
    question: "Is the brief executable?",
  },
  { "x-agent-key": chiefKey },
);
const factId = asked.body?.id;
say(asked.status === 201 && !!factId, "POST /fact-requests as an agent", `${asked.status}`);

const missingPipeline = await api(
  "post",
  `/api/companies/${COMPANY_ID}/fact-requests`,
  { targetAgentId: agentId, factKey: "x", runId: "y", question: "z" },
  { "x-agent-key": chiefKey },
);
say(missingPipeline.status === 400, "omitting pipelineId is a 400, as the brief warns", `${missingPipeline.status}`);

const inbox = await api("get", `/api/companies/${COMPANY_ID}/fact-requests?role=target`, null, {
  "x-agent-key": agentKey,
});
const pending = inbox.body?.factRequests ?? [];
say(pending.some((f) => f.id === factId), "target agent sees the ask", `${pending.length} pending`);

const answered = await api(
  "post",
  `/api/companies/${COMPANY_ID}/fact-requests/${factId}/answer`,
  { answer: "Yes — every call in it is exercised here.", sourceKind: "harness" },
  { "x-agent-key": agentKey },
);
say(answered.status === 200, "answer with a valid sourceKind", `${answered.status}`);

const badKind = await api(
  "post",
  `/api/companies/${COMPANY_ID}/fact-requests/${factId}/answer`,
  { answer: "x", sourceKind: "system" },
  { "x-agent-key": agentKey },
);
say(badKind.status === 400, 'sourceKind "system" is rejected, as the brief warns', `${badKind.status}`);

const requesterView = await api("get", `/api/companies/${COMPANY_ID}/fact-requests?role=requester`, null, {
  "x-agent-key": chiefKey,
});
const seen = (requesterView.body?.factRequests ?? []).find((f) => f.id === factId);
say(seen?.status === "answered", "requester sees it answered", seen?.status ?? "missing");
say(
  typeof seen?.answer === "string" && seen.answer.includes("<untrusted-agent-answer>"),
  "peer answer carries the untrusted-agent-answer boundary",
);

const ownerAsAgent = await api("post", `/api/companies/${COMPANY_ID}/fact-requests`, {
  targetAgentId: agentId,
  factKey: "owner_attempt",
  runId: "r",
  pipelineId: "p",
  question: "q",
});
say(
  ownerAsAgent.status === 401 || ownerAsAgent.status === 403,
  "the owner's bearer cannot act as an agent",
  `${ownerAsAgent.status}`,
);

console.log(`\n${broken === 0 ? "BRIEF VERIFIED" : "BRIEF HAS BROKEN CALLS"} — ok=${ok} broken=${broken}\n`);
process.exit(broken === 0 ? 0 : 1);
