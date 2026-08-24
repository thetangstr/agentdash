#!/usr/bin/env node
/**
 * A full pass over the paths a person and an agent actually use.
 *
 * This is not a substitute for the unit suites — it is the thing they cannot
 * do: drive a running instance end to end, in order, the way the product is
 * really used. Sign up, make a company, make both kinds of agent, mint and
 * refuse credentials, unpair and re-kind an agent, invite a colleague, hand
 * over accountability, read it all back as the agent itself, and run one.
 *
 * Written to be run against a THROWAWAY instance. It creates companies, agents,
 * users and invites, and it does not clean up after itself: the intended
 * teardown is dropping the database it ran against.
 *
 *   node scripts/e2e/full-pass.mjs                     # http://127.0.0.1:3199
 *   E2E_BASE=http://127.0.0.1:4000 node scripts/e2e/full-pass.mjs
 *
 * Exits non-zero if any check fails, so CI or a wrapper script can gate on it.
 */

const BASE = (process.env.E2E_BASE ?? "http://127.0.0.1:3199").replace(/\/$/, "");

/**
 * Refuse to run anywhere that looks like somebody's production instance.
 *
 * This suite signs up users and creates companies. Pointed at a live board it
 * would write junk into a customer's workspace, and the failure mode is silent
 * — everything "passes" while polluting real data. The known production ports
 * on the reference deployment are 3102 (app) and 3112 (TLS front), so those are
 * refused outright, as is any non-loopback host.
 *
 * `E2E_I_KNOW_THIS_IS_NOT_PRODUCTION=1` exists for a deliberate remote test
 * instance. It is deliberately verbose to type.
 */
function assertSafeTarget() {
  if (process.env.E2E_I_KNOW_THIS_IS_NOT_PRODUCTION === "1") return;
  const url = new URL(BASE);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  const productionPort = ["3102", "3112"].includes(url.port);
  if (!loopback || productionPort) {
    console.error(
      `Refusing to run against ${BASE}.\n\n` +
        "This suite creates users, companies and agents and does not clean up.\n" +
        "Point it at a throwaway instance on loopback, or set\n" +
        "E2E_I_KNOW_THIS_IS_NOT_PRODUCTION=1 if you are certain.",
    );
    process.exit(2);
  }
}

let cookie = "";
let passed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function call(method, path, body, opts = {}) {
  const headers = { Origin: BASE };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  else if (cookie && !opts.noCookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && opts.captureCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

assertSafeTarget();

const stamp = Date.now();
const ADMIN = { email: `admin-${stamp}@e2e.test`, password: "e2e-Password-123456", name: "E2E Admin" };
const COLLEAGUE = {
  email: `colleague-${stamp}@e2e.test`,
  password: "e2e-Password-654321",
  name: "E2E Colleague",
};
const PROCESS_AGENT = { adapterType: "process", adapterConfig: { command: "echo" } };

console.log(`Running a full pass against ${BASE}`);

// ---------------------------------------------------------------- 1. boots
section("1. The instance boots and describes its own state");
const health = await call("GET", "/api/health");
ok("health is ok", health.body?.status === "ok", JSON.stringify(health.body));
ok(
  "reports whether a company exists rather than guessing",
  typeof health.body?.instanceHasCompany === "boolean",
  JSON.stringify(health.body?.instanceHasCompany),
);

// ---------------------------------------------------------------- 2. sign up
section("2. A person signs themselves up and creates a company");
const signup = await call("POST", "/api/auth/sign-up/email", ADMIN, { captureCookie: true });
ok("sign-up succeeds", signup.status === 200 && !!signup.body?.user?.id, `status=${signup.status}`);
const adminUserId = signup.body?.user?.id;

const session = await call("GET", "/api/auth/get-session");
ok("the session resolves to that person", session.body?.user?.id === adminUserId);

const company = await call("POST", "/api/companies", {
  name: `E2E Co ${stamp}`,
  issuePrefix: `E${String(stamp).slice(-5)}`,
});
ok("company is created", [200, 201].includes(company.status), `status=${company.status}`);
const companyId = company.body?.id ?? company.body?.company?.id;
ok("company has an id", !!companyId);

// ---------------------------------------------------------------- 3. personal agent
section("3. A personal agent is paired with its creator and holds credentials");
const personal = await call("POST", `/api/companies/${companyId}/agents`, {
  name: "Personal Agent",
  role: "engineer",
  ...PROCESS_AGENT,
});
ok("created", personal.status === 201, `status=${personal.status}`);
const personalId = personal.body?.id;
ok("defaults to stewarded", personal.body?.autonomy === "stewarded", personal.body?.autonomy);
ok("carries no accountable column of its own", personal.body?.accountableUserId === null);

const myAgent = await call("GET", `/api/companies/${companyId}/me/agent`);
ok("the creator is paired with it, so they can run it", myAgent.body?.agent?.id === personalId);

const listed = await call("GET", `/api/companies/${companyId}/agents`);
const personalRow = (listed.body ?? []).find((a) => a.id === personalId);
ok("reads back with a steward", personalRow?.steward?.userId === adminUserId);
ok(
  "and an accountable party resolved from that steward",
  personalRow?.accountable?.userId === adminUserId && personalRow?.accountable?.via === "steward",
  JSON.stringify(personalRow?.accountable),
);

const code = await call("POST", `/api/agents/${personalId}/connect-codes`, {});
ok("a connect code can be minted", code.status === 201 && !!code.body?.code, `status=${code.status}`);
const key = await call("POST", `/api/agents/${personalId}/keys`, { name: "e2e" });
ok("a key can be minted", key.status === 201 && !!key.body?.token, `status=${key.status}`);
const personalKey = key.body?.token;

// ---------------------------------------------------------------- 4. autonomous agent
section("4. An autonomous agent has no steward, no credentials, and still answers to somebody");
const auto = await call("POST", `/api/companies/${companyId}/agents`, {
  name: "Sweeper",
  role: "engineer",
  ...PROCESS_AGENT,
  autonomy: "autonomous",
});
ok("created", auto.status === 201, `status=${auto.status}`);
const autoId = auto.body?.id;
ok("kind is recorded", auto.body?.autonomy === "autonomous");
ok("creator becomes accountable by default", auto.body?.accountableUserId === adminUserId);

const autoRow = (await call("GET", `/api/companies/${companyId}/agents`)).body.find(
  (a) => a.id === autoId,
);
ok("reads back with no steward", autoRow?.steward === null);
ok(
  "and an accountable party by assignment",
  autoRow?.accountable?.userId === adminUserId && autoRow?.accountable?.via === "assignment",
  JSON.stringify(autoRow?.accountable),
);

ok(
  "refuses a connect code",
  (await call("POST", `/api/agents/${autoId}/connect-codes`, {})).status === 409,
);
ok("refuses a key", (await call("POST", `/api/agents/${autoId}/keys`, { name: "no" })).status === 409);
ok(
  "refuses to pair a human with it",
  (
    await call("POST", `/api/companies/${companyId}/agent-stewardships`, {
      agentId: autoId,
      userId: adminUserId,
    })
  ).status === 409,
);

// ---------------------------------------------------------------- 5. one human, many agents
section("5. One person can answer for several autonomous agents");
const second = await call("POST", `/api/companies/${companyId}/agents`, {
  name: "Reporter",
  role: "engineer",
  ...PROCESS_AGENT,
  autonomy: "autonomous",
});
ok("a second autonomous agent is created", second.status === 201, `status=${second.status}`);
const accountableFor = (await call("GET", `/api/companies/${companyId}/agents`)).body.filter(
  (a) => a.accountable?.userId === adminUserId,
);
ok("the same person answers for three at once", accountableFor.length === 3, `count=${accountableFor.length}`);

// ---------------------------------------------------------------- 6. release, then re-kind
section("6. Release a pairing, then make that agent autonomous");
const blocked = await call("PATCH", `/api/agents/${personalId}`, { autonomy: "autonomous" });
ok("refused while the pairing is live", blocked.status === 409, `status=${blocked.status}`);
ok(
  "and the refusal names the steward",
  typeof blocked.body?.error === "string" && blocked.body.error.includes("stewarded by"),
  blocked.body?.error,
);

const released = await call(
  "POST",
  `/api/companies/${companyId}/agents/${personalId}/stewardship/release`,
  { releaseReason: "moving it to the autonomous team" },
);
ok("release succeeds", released.status === 200, `status=${released.status}`);
ok(
  "the person now stewards nothing",
  !(await call("GET", `/api/companies/${companyId}/me/agent`)).body?.agent,
);

const unpaired = (await call("GET", `/api/companies/${companyId}/agents`)).body.find(
  (a) => a.id === personalId,
);
ok(
  "the agent reads as unpaired, which is distinguishable from autonomous",
  unpaired?.autonomy === "stewarded" && unpaired?.accountable === null,
  `${unpaired?.autonomy} / ${JSON.stringify(unpaired?.accountable)}`,
);

const nowAuto = await call("PATCH", `/api/agents/${personalId}`, { autonomy: "autonomous" });
ok("the same edit now succeeds", nowAuto.status === 200, `status=${nowAuto.status}`);
ok("accountability defaults to whoever did it", nowAuto.body?.accountableUserId === adminUserId);

// ---------------------------------------------------------------- 7. invite
section("7. Invite a colleague, then hand them an agent's accountability");
const invite = await call("POST", "/api/onboarding/invites", {
  companyId,
  emails: [COLLEAGUE.email],
  autoApprove: true,
});
ok("invite is created", [200, 201].includes(invite.status), `status=${invite.status}`);
const entry = invite.body?.invites?.[0] ?? invite.body?.results?.[0] ?? null;
const inviteUrl = entry?.inviteUrl ?? entry?.url ?? null;
ok("and carries a link to hand over", !!inviteUrl, JSON.stringify(entry).slice(0, 160));
const token = inviteUrl
  ? new URL(inviteUrl).searchParams.get("token") ?? inviteUrl.split("/").pop()
  : null;
ok("the link carries a token", !!token);

const adminCookie = cookie;
cookie = "";
const colleagueSignup = await call("POST", "/api/auth/sign-up/email", COLLEAGUE, {
  captureCookie: true,
});
ok("the colleague signs up", colleagueSignup.status === 200, `status=${colleagueSignup.status}`);
const colleagueUserId = colleagueSignup.body?.user?.id;

const accept = await call("POST", `/api/invites/${token}/accept`, { requestType: "human" });
// 202 with an approved join request is the success shape when autoApprove is on.
ok(
  "and accepts the invite",
  [200, 201, 202].includes(accept.status) && accept.body?.status === "approved",
  `status=${accept.status} ${JSON.stringify(accept.body).slice(0, 120)}`,
);

cookie = adminCookie;
const members = await call("GET", `/api/companies/${companyId}/members`);
ok("the colleague is a member", JSON.stringify(members.body).includes(colleagueUserId));

const handover = await call("PATCH", `/api/agents/${autoId}`, { accountableUserId: colleagueUserId });
ok(
  "accountability transfers to them",
  handover.status === 200 && handover.body?.accountableUserId === colleagueUserId,
  `status=${handover.status}`,
);
ok(
  "but not to somebody who is not a member",
  (
    await call("PATCH", `/api/agents/${autoId}`, {
      accountableUserId: "00000000-0000-0000-0000-000000000000",
    })
  ).status === 409,
);

// ---------------------------------------------------------------- 8. the agent's own view
section("8. What the agent sees through its own credential");
const me = await call("GET", "/api/agents/me", undefined, { bearer: personalKey, noCookie: true });
ok("an agent key authenticates", me.status === 200, `status=${me.status}`);
ok("the agent is told its own kind", me.body?.autonomy === "autonomous", me.body?.autonomy);
ok(
  "and who answers for it, even with no steward",
  me.body?.steward === null && me.body?.accountable?.userId === adminUserId,
  JSON.stringify({ steward: me.body?.steward, accountable: me.body?.accountable }),
);

const mcp = await fetch(`${BASE}/api/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${personalKey}`,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
const mcpText = await mcp.text();
ok("the MCP endpoint accepts that credential", mcp.status === 200, `status=${mcp.status}`);
ok("and offers whoami", mcpText.includes("whoami"));

// ---------------------------------------------------------------- 9. a real run
section("9. An agent actually runs");
const runnable = await call("POST", `/api/companies/${companyId}/agents`, {
  name: "Runner",
  role: "engineer",
  adapterType: "process",
  adapterConfig: { command: "echo", args: ["e2e run"] },
  autonomy: "autonomous",
  runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1800, cooldownSec: 1 } },
});
ok("a runnable agent is created", runnable.status === 201, `status=${runnable.status}`);
const runnerId = runnable.body?.id;

const wake = await call("POST", `/api/agents/${runnerId}/wakeup`, { reason: "e2e" });
ok("it can be woken on demand", [200, 201, 202].includes(wake.status), `status=${wake.status}`);

let runs = [];
for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const res = await call(
    "GET",
    `/api/companies/${companyId}/heartbeat-runs?agentId=${runnerId}&limit=5`,
  );
  runs = Array.isArray(res.body) ? res.body : (res.body?.runs ?? []);
  if (runs.some((run) => run.status !== "running" && run.status !== "queued")) break;
}
const finished = runs.find((run) => run.status !== "running" && run.status !== "queued");
ok("the run reaches a terminal state", !!finished, JSON.stringify(runs.slice(0, 1)).slice(0, 200));
ok("and it succeeded", finished?.status === "succeeded", `${finished?.status}`);

// ---------------------------------------------------------------- summary
section(`Result: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) {
  console.log(`  FAILED: ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}`);
}
process.exit(failures.length === 0 ? 0 : 1);
