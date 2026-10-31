// Tests for scripts/hosted/internal-box.mjs (doc/runbooks/internal-box.md).
//
// Everything runs against fakes: the control plane's /internal routes, GHCR,
// a hosted box, a source AgentDash instance, macOS `security` and the
// `railway` CLI. The control-plane calls go through the real operator CLI
// code (cloud/src/admin/run.ts, loaded with tsx), so these tests also prove
// the tool and `admin` agree on the wire. They prove:
//   - preflight maps each failure to its fix-it text (IP allow-list, token,
//     Railway login, release floor, missing GHCR image) and exits non-zero;
//   - create is idempotent: an existing internal box is reported, never
//     recreated; a customer box with the slug is refused; --dry-run posts nothing;
//   - claim stores the password in the Keychain BEFORE the account exists,
//     never prints or passes on argv the password, the claim code or the
//     admin token, waits for the control plane to close sign-up, redeploys,
//     and refuses a claim email that does not match the box;
//   - move-company is a dry run by default (no writes to the box), and
//     --apply imports with every agent on hermes_local, clears issue adapter
//     overrides, verifies counts, reports the goal gap, and never imports twice;
//   - configure reads the provider key from the Keychain and never prints it;
//   - status formats health, release, purpose and backups.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, newPassword, hermesPlan, bundleCounts, verifyCounts, formatStatus, summarizeBackups, parseArgs, realExec, loadCloud } from "./internal-box.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "internal-box.mjs");

const ADMIN = "admin-token-SECRET-1111111111";
const CLAIM_CODE = "claim-code-SECRET-2222222222";
const ROTATED_CODE = "rotated-code-SECRET-3333333333";
const PROVIDER_KEY = "sk-provider-SECRET-4444444444";
const SOURCE_TOKEN = `pcp_board_${"ab".repeat(24)}`;
const CP = "https://cloud.test";
const BOX = "https://ibox.agentdash.cloud";
const SRC = "https://source.test";
const SLUG = "ibox";
const EMAIL = "ops@agentdash.cloud";
const RELEASE = "v2026.1030.0";

const cloud = await loadCloud();

// ---------------------------------------------------------------------------
// The fake world
// ---------------------------------------------------------------------------

function json(status, body, headers = {}) {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function sourceCompany() {
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-10-31T00:00:00.000Z",
    source: { companyId: "c0000000-0000-4000-8000-000000000001", companyName: "Acme" },
    includes: { company: true, agents: true, projects: true, issues: true, skills: true },
    company: { path: "COMPANY.md", name: "Acme", description: "d", brandColor: null, logoPath: null, requireBoardApprovalForNewAgents: false },
    sidebar: null,
    agents: [
      { slug: "cos", name: "CoS", path: "agents/cos/AGENTS.md", skills: [], role: "ceo", title: null, icon: null, capabilities: null, reportsToSlug: null, adapterType: "claude_local", adapterConfig: { model: "claude-opus", command: "/usr/local/bin/claude", env: { X: "1" } }, runtimeConfig: {}, permissions: {}, budgetMonthlyCents: 0, metadata: null },
      { slug: "eng", name: "Eng", path: "agents/eng/AGENTS.md", skills: [], role: "engineer", title: null, icon: null, capabilities: null, reportsToSlug: "cos", adapterType: "hermes_local", adapterConfig: { model: "glm-5.3-flash" }, runtimeConfig: {}, permissions: {}, budgetMonthlyCents: 0, metadata: null },
    ],
    skills: [],
    projects: [{ slug: "web", name: "Web", path: "projects/web/PROJECT.md", description: null, ownerAgentSlug: null, leadAgentSlug: null, targetDate: null, color: null, status: null, executionWorkspacePolicy: null, workspaces: [], metadata: null }],
    issues: [
      { slug: "i1", identifier: "ACM-1", title: "One", path: "issues/i1.md", projectSlug: "web", projectWorkspaceKey: null, assigneeAgentSlug: "eng", description: null, recurring: false, routine: null, legacyRecurrence: null, status: "todo", priority: "medium", labelIds: [], billingCode: null, executionWorkspaceSettings: null, assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus" }, modelProfile: "fast" }, metadata: null },
      { slug: "i2", identifier: "ACM-2", title: "Two", path: "issues/i2.md", projectSlug: null, projectWorkspaceKey: null, assigneeAgentSlug: null, description: null, recurring: false, routine: null, legacyRecurrence: null, status: "backlog", priority: "low", labelIds: [], billingCode: null, executionWorkspaceSettings: null, assigneeAdapterOverrides: null, metadata: null },
      { slug: "r1", identifier: null, title: "Weekly", path: "issues/r1.md", projectSlug: null, projectWorkspaceKey: null, assigneeAgentSlug: "cos", description: null, recurring: true, routine: { concurrencyPolicy: null, catchUpPolicy: null, triggers: [] }, legacyRecurrence: null, status: null, priority: null, labelIds: [], billingCode: null, executionWorkspaceSettings: null, assigneeAdapterOverrides: null, metadata: null },
    ],
    envInputs: [],
  };
  return {
    company: { id: "c0000000-0000-4000-8000-000000000001", name: "Acme", description: "d" },
    agents: [{ id: "sa1", name: "CoS", status: "idle" }, { id: "sa2", name: "Eng", status: "idle" }, { id: "sa3", name: "Old", status: "terminated" }],
    projects: [{ id: "sp1", name: "Web" }],
    issues: [{ id: "si1" }, { id: "si2" }],
    goals: [{ id: "sg1" }],
    bundle: { rootPath: "acme", manifest, files: { "COMPANY.md": "# Acme" }, warnings: [], paperclipExtensionPath: ".paperclip.yaml" },
  };
}

function world(opts = {}) {
  const log = [];
  const outLines = [];
  const errLines = [];
  let now = Date.parse("2026-10-31T12:00:00Z");
  const keychain = new Map(Object.entries({ "agentdash-cloud-admin-token": ADMIN, ...(opts.keychain ?? {}) }));
  const cp = {
    allowIp: opts.allowIp ?? true,
    token: ADMIN,
    ip: opts.reportIp ?? null,
    settings: { provisioning_enabled: true, waitlist_mode: true, daily_cap: 10, ...(opts.settings ?? {}) },
    boxes: opts.boxes ?? [],
    jobs: opts.jobs ?? [],
    backups: opts.backups ?? [],
    provisionTicks: opts.provisionTicks ?? 2,
  };
  const rail = {
    loggedIn: opts.railwayLoggedIn ?? true,
    vars: {
      PAPERCLIP_ALLOWED_HOSTNAMES: `${SLUG}.agentdash.cloud,web-ibox.up.railway.app`,
      AGENTDASH_INVITE_CODES: CLAIM_CODE,
      AGENTDASH_CLAIM_EMAIL: EMAIL,
      BETTER_AUTH_SECRET: "auth-secret-SECRET-5555555555",
      PAPERCLIP_SECRETS_MASTER_KEY: "master-key-SECRET-6666666666",
      ...(opts.railwayVars ?? {}),
    },
    redeploys: 0,
  };
  const box = {
    users: opts.boxUsers ?? [],
    sessions: new Set(),
    signUpDisabled: opts.signUpDisabled ?? false,
    pendingSignUpDisabled: false,
    companies: opts.boxCompanies ?? [],
    agents: [],
    projects: [],
    issues: [],
    goals: [],
    provider: opts.provider ?? { configured: false, provider: null, model: null },
    instanceAdmin: null,
  };
  const src = sourceCompany();
  const ghcrTags = opts.ghcrTags ?? [RELEASE];
  const cpBox = (slug) => cp.boxes.find((b) => b.slug === slug);

  // Each sleep advances the clock and the world: provisioning steps, the claim sweep,
  // the close_signup job, a requested redeploy.
  function tick() {
    for (const b of cp.boxes) {
      if (b.state === "provisioning") {
        b._ticks = (b._ticks ?? 0) + 1;
        const job = cp.jobs.find((j) => j.slug === b.slug && j.kind === "provision");
        if (job) Object.assign(job, { state: "running", step: ["reserve", "project", "variables", "deploy", "health"][Math.min(b._ticks, 4)], attempt: 1 });
        if (b._ticks >= cp.provisionTicks) {
          b.state = "awaiting_claim";
          b.publicUrl = BOX;
          if (job) Object.assign(job, { state: "succeeded", step: "publish" });
        }
      }
      if (b.state === "awaiting_claim" && box.users.length > 0) {
        b.state = "active";
        b.claimedAt = new Date(now).toISOString();
        cp.jobs.push({ id: `j-close-${b.slug}`, slug: b.slug, kind: "close_signup", state: "queued", step: null, attempt: 0, lastError: null, createdAt: new Date(now).toISOString() });
      } else {
        const close = cp.jobs.find((j) => j.slug === b.slug && j.kind === "close_signup" && j.state === "queued");
        if (close && !opts.closeSignupNeverRuns) {
          close.state = "succeeded";
          Object.assign(rail.vars, { PAPERCLIP_AUTH_DISABLE_SIGN_UP: "true", AGENTDASH_INVITE_CODES: ROTATED_CODE, AGENTDASH_CLAIM_EMAIL: "" });
        }
      }
    }
    if (box.pendingSignUpDisabled) box.signUpDisabled = true;
  }

  const authed = (init) => {
    const cookie = new Headers(init?.headers ?? {}).get("cookie") ?? "";
    return [...box.sessions].some((s) => cookie.includes(s));
  };
  const companyRoute = (p) => /^\/api\/companies\/([^/]+)\/(agents|projects|goals|issues)$/.exec(p);

  async function controlPlane(u, method, init, body) {
    const auth = new Headers(init?.headers ?? {}).get("authorization");
    if (!cp.allowIp) return json(403, { error: "forbidden", ...(cp.ip ? { ip: cp.ip } : {}) });
    if (auth !== `Bearer ${cp.token}`) return json(401, { error: "unauthorized" });
    const p = u.pathname.replace(/^\/internal/, "");
    if (method === "GET" && p === "/settings") return json(200, cp.settings);
    if (method === "GET" && p === "/boxes") return json(200, { boxes: cp.boxes.map(({ _ticks, ...b }) => b) });
    if (method === "POST" && p === "/boxes") {
      if (cpBox(body.slug)) return json(409, { error: `slug ${body.slug} is taken` });
      cp.boxes.push({ id: `b-${body.slug}`, slug: body.slug, purpose: body.purpose ?? "customer", state: "provisioning", releaseTag: body.releaseTag, holdUpgrades: false, publicUrl: null, claimedAt: null, planTier: null, createdAt: new Date(now).toISOString() });
      cp.jobs.push({ id: `j-${body.slug}`, slug: body.slug, kind: "provision", state: "queued", step: null, attempt: 0, lastError: null, createdAt: new Date(now).toISOString() });
      return json(201, { slug: body.slug, boxId: `b-${body.slug}`, provisioning: { outcome: "queued", jobId: `j-${body.slug}` } });
    }
    const m = /^\/boxes\/([^/]+)\/(retry|health|backups)$/.exec(p);
    if (m && cpBox(m[1])) {
      const b = cpBox(m[1]);
      if (m[2] === "retry" && method === "POST") {
        b.state = "provisioning";
        const job = cp.jobs.find((j) => j.slug === b.slug && j.kind === "provision");
        Object.assign(job, { state: "queued", attempt: 0 });
        return json(200, { slug: b.slug, jobId: job.id, step: job.step });
      }
      if (m[2] === "health") return json(200, { slug: b.slug, state: b.state, releaseTag: b.releaseTag, lastHealth: { status: "ok", releaseTag: b.releaseTag }, paths: [{ path: "direct", status: "ok", consecutiveFailures: 0 }, { path: "router", status: "ok", consecutiveFailures: 0 }], firingAlerts: [], recentEvents: [] });
      if (m[2] === "backups") return json(200, { backups: cp.backups });
    }
    if (method === "GET" && p === "/jobs") return json(200, { jobs: cp.jobs });
    return json(404, { error: `fake control plane: no route ${method} ${p}` });
  }

  async function boxApi(u, method, init, body) {
    const p = u.pathname;
    if (method === "GET" && p === "/api/health") {
      return json(200, { status: "ok", deploymentMode: "authenticated", hostedBox: true, releaseTag: RELEASE, claimed: box.users.length > 0, signUpDisabled: box.signUpDisabled, adapterReady: box.provider.configured });
    }
    if (method === "POST" && p === "/api/auth/sign-up/email") {
      if (!body.inviteCode) return json(403, { code: "invite_code_required" });
      if (box.signUpDisabled) return json(403, { code: "signup_disabled" });
      if (body.inviteCode !== rail.vars.AGENTDASH_INVITE_CODES) return json(403, { code: "invalid_invite_code" });
      if (box.users.length > 0) return json(409, { code: "claim_code_used" });
      if (body.email.toLowerCase() !== rail.vars.AGENTDASH_CLAIM_EMAIL) return json(403, { code: "claim_email_mismatch" });
      box.users.push({ email: body.email, password: body.password, name: body.name });
      return json(200, { user: { email: body.email } });
    }
    if (method === "POST" && p === "/api/auth/sign-in/email") {
      const user = box.users.find((x) => x.email === body.email && x.password === body.password);
      if (!user) return json(401, { error: "invalid" });
      const s = `sess${box.sessions.size}x${"9".repeat(12)}`;
      box.sessions.add(s);
      return json(200, { ok: true }, { "set-cookie": `__Secure-better-auth.session_token=${s}; Path=/; HttpOnly; Secure` });
    }
    if (!authed(init)) return json(401, { error: "unauthorized" });
    if (method !== "GET" && new Headers(init?.headers ?? {}).get("origin") !== BOX) return json(403, { error: "origin" });
    if (method === "GET" && p === "/api/companies") return json(200, box.companies);
    if (method === "POST" && p === "/api/companies") {
      if (box.companies.length) return json(409, { code: "single_company" });
      const c = { id: "tc000000-0000-4000-8000-000000000009", name: body.name };
      box.companies.push(c);
      box.instanceAdmin = EMAIL;
      return json(201, c);
    }
    const cr = companyRoute(p);
    if (method === "GET" && cr) return json(200, box[cr[2]]);
    if (method === "POST" && p === "/api/companies/import/preview") return json(200, { errors: [], warnings: [] });
    if (method === "POST" && p === "/api/companies/import") {
      const m = body.source.files && src.bundle.manifest;
      for (const a of m.agents) {
        const o = body.adapterOverrides?.[a.slug];
        box.agents.push({ id: `ta-${a.slug}`, name: a.name, status: "idle", adapterType: o?.adapterType ?? a.adapterType, adapterConfig: o?.adapterConfig ?? a.adapterConfig });
      }
      for (const pr of m.projects) box.projects.push({ id: `tp-${pr.slug}`, name: pr.name });
      for (const i of m.issues.filter((x) => !x.recurring)) box.issues.push({ id: `ti-${i.slug}`, identifier: i.identifier, assigneeAdapterOverrides: i.assigneeAdapterOverrides });
      return json(200, { company: { id: body.target.companyId, name: "Acme", action: "updated" }, agents: box.agents.map((a) => ({ slug: a.id, id: a.id, action: "created" })), projects: box.projects, envInputs: [], warnings: [] });
    }
    let m = /^\/api\/agents\/([^/]+)$/.exec(p);
    if (method === "PATCH" && m) {
      const a = box.agents.find((x) => x.id === m[1]);
      if (body.adapterType) a.adapterType = body.adapterType;
      if (body.adapterConfig) a.adapterConfig = body.replaceAdapterConfig ? body.adapterConfig : { ...a.adapterConfig, ...body.adapterConfig };
      return json(200, a);
    }
    m = /^\/api\/issues\/([^/]+)$/.exec(p);
    if (method === "PATCH" && m) {
      const i = box.issues.find((x) => x.id === m[1]);
      i.assigneeAdapterOverrides = body.assigneeAdapterOverrides;
      return json(200, i);
    }
    if (method === "GET" && p === "/api/onboarding/adapter-status") return json(200, { hermesProvider: { required: true, ...box.provider, canConfigure: box.instanceAdmin !== null } });
    if (method === "POST" && p === "/api/onboarding/setup-adapter") {
      box.provider = { configured: true, provider: body.provider, model: body.model ?? "glm-5.3-flash", apiKey: body.apiKey };
      return json(201, { hermesProvider: { configured: true, provider: body.provider, label: "Z.AI (GLM)", model: box.provider.model }, profilesUpdated: box.agents.length });
    }
    return json(404, { error: `fake box: no route ${method} ${p}` });
  }

  async function sourceApi(u, method, init) {
    if (new Headers(init?.headers ?? {}).get("authorization") !== `Bearer ${SOURCE_TOKEN}`) return json(401, { error: "unauthorized" });
    const p = u.pathname;
    if (method === "GET" && p === "/api/companies") return json(200, [src.company, { id: "c0000000-0000-4000-8000-000000000002", name: "Other" }]);
    const cr = companyRoute(p);
    if (method === "GET" && cr) return json(200, src[cr[2]]);
    if (method === "POST" && /^\/api\/companies\/[^/]+\/export$/.test(p)) return json(200, src.bundle);
    return json(404, { error: `fake source: no route ${method} ${p}` });
  }

  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push({ kind: "fetch", method, url: `${u.origin}${u.pathname}`, body });
    if (u.origin === CP) return controlPlane(u, method, init, body);
    if (u.origin === "https://ghcr.io") {
      if (u.pathname === "/token") return json(200, { token: "pull" });
      const tag = u.pathname.split("/").pop();
      return ghcrTags.includes(tag) ? new Response(null, { status: 200, headers: { "docker-content-digest": `sha256:${"a".repeat(64)}` } }) : new Response(null, { status: 404 });
    }
    if (u.origin === BOX) return boxApi(u, method, init, body);
    if (u.origin === "https://web-ibox.up.railway.app") throw new TypeError("fetch failed");
    if (u.origin === SRC) return sourceApi(u, method, init);
    throw new TypeError(`fetch failed: unexpected ${u.origin}`);
  };

  const exec = async (cmd, args, { input, cwd } = {}) => {
    log.push({ kind: "exec", cmd, args: [...args], input: input ?? null, cwd: cwd ?? null });
    if (cmd === "security") {
      if (args[0] === "find-generic-password") {
        const svc = args[args.indexOf("-s") + 1];
        if (!keychain.has(svc)) return { code: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n" };
        return { code: 0, stdout: args.includes("-w") ? `${keychain.get(svc)}\n` : `keychain: "login.keychain-db"\n`, stderr: "" };
      }
      if (args[0] === "-i") {
        if (opts.keychainWriteFails) return { code: 0, stdout: "security> ", stderr: "write failed\n" };
        for (const line of (input ?? "").split("\n").filter(Boolean)) {
          const t = line.trim().split(/\s+/);
          if (t[0] !== "add-generic-password") continue;
          keychain.set(t[t.indexOf("-s") + 1], t[t.indexOf("-w") + 1]);
        }
        return { code: 0, stdout: "security> ", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected security call" };
    }
    if (cmd === "railway") {
      if (!rail.loggedIn) return { code: 1, stdout: "", stderr: "Unauthorized. Please login with `railway login`" };
      if (args[0] === "whoami") return { code: 0, stdout: "Logged in as ops@agentdash.cloud\n", stderr: "" };
      if (args[0] === "list") return { code: 0, stdout: JSON.stringify([{ id: "p-other", name: "agentdash" }, { id: "p-ibox", name: `agentdash-box-${SLUG}` }]), stderr: "" };
      if (args[0] === "link") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "variables") return { code: 0, stdout: JSON.stringify(rail.vars), stderr: "" };
      if (args[0] === "redeploy") {
        rail.redeploys += 1;
        if (rail.vars.PAPERCLIP_AUTH_DISABLE_SIGN_UP === "true") box.pendingSignUpDisabled = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected railway call" };
    }
    return { code: 127, stdout: "", stderr: `${cmd}: not found` };
  };

  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "internal-box-test-"));
  const env = { CLOUD_CONTROL_URL: CP, ...(opts.env ?? {}) };
  const deps = {
    env,
    fetch,
    exec,
    cloud,
    stateRoot,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      tick();
    },
    out: (l) => outLines.push(l),
    err: (l) => errLines.push(l),
  };
  const w = {
    deps,
    log,
    keychain,
    cp,
    box,
    rail,
    src,
    stateRoot,
    output: () => [...outLines, ...errLines].join("\n"),
    stdout: () => outLines.join("\n"),
    run: (argv) => run(argv, deps),
    fetches: (pred = () => true) => log.filter((e) => e.kind === "fetch" && pred(e)),
    execs: (pred = () => true) => log.filter((e) => e.kind === "exec" && pred(e)),
    argvText: () => log.filter((e) => e.kind === "exec").map((e) => `${e.cmd} ${e.args.join(" ")}`).join("\n"),
    state: () => JSON.parse(readFileSync(path.join(stateRoot, SLUG, "internal-box.json"), "utf8")),
    cleanup: () => rmSync(stateRoot, { recursive: true, force: true }),
    reset: () => {
      outLines.length = 0;
      errLines.length = 0;
      log.length = 0;
    },
  };
  return w;
}

const internalBox = (over = {}) => ({ id: "b-ibox", slug: SLUG, purpose: "internal", state: "awaiting_claim", releaseTag: RELEASE, holdUpgrades: false, publicUrl: BOX, claimedAt: null, planTier: null, createdAt: "2026-10-31T10:00:00.000Z", ...over });

function assertNoSecrets(w, extra = []) {
  const printed = w.output();
  const argv = w.argvText();
  const all = [ADMIN, CLAIM_CODE, ROTATED_CODE, PROVIDER_KEY, SOURCE_TOKEN, "auth-secret-SECRET-5555555555", "master-key-SECRET-6666666666", ...extra];
  for (const s of all) {
    assert.ok(!printed.includes(s), `printed output leaked a secret (${s.slice(0, 8)}…)`);
    assert.ok(!argv.includes(s), `a child's argv carried a secret (${s.slice(0, 8)}…)`);
  }
  assert.doesNotMatch(printed, /session_token=sess/, "a session cookie was printed");
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

test("preflight: missing control URL and token give the exact fix-it text and exit non-zero", async () => {
  const w = world({ env: { CLOUD_CONTROL_URL: "" } });
  w.keychain.delete("agentdash-cloud-admin-token");
  try {
    const code = await w.run(["preflight"]);
    assert.equal(code, 1);
    const out = w.output();
    assert.match(out, /\[FAIL\] control-url: CLOUD_CONTROL_URL is not set/);
    assert.match(out, /fix: export CLOUD_CONTROL_URL=https:\/\/cloud-control-production\.up\.railway\.app/);
    assert.match(out, /\[FAIL\] admin-token: .*Keychain item agentdash-cloud-admin-token is missing/);
    assert.match(out, /fix: security add-generic-password -s agentdash-cloud-admin-token -a "\$USER" -w/);
    assert.match(out, /\[skip\] operator-surface/);
    assert.equal(w.fetches().length, 0, "nothing is called without credentials");
  } finally {
    w.cleanup();
  }
});

test("preflight: a 403 from the allow-list is reported as this machine's IP, with the IP when the API gives it", async () => {
  const w = world({ allowIp: false });
  try {
    assert.equal(await w.run(["preflight"]), 1);
    assert.match(w.output(), /\[FAIL\] operator-surface: this machine's IP is not on CLOUD_ADMIN_ALLOWED_IPS \(the control plane does not say which address it saw\)/);
    assert.match(w.output(), /fix: find this machine's public address .* to CLOUD_ADMIN_ALLOWED_IPS on the cloud-control service/);
  } finally {
    w.cleanup();
  }
  const v = world({ allowIp: false, reportIp: "203.0.113.7" });
  try {
    assert.equal(await v.run(["preflight", "--json"]), 1);
    const doc = JSON.parse(v.stdout());
    const check = doc.result.checks.find((c) => c.name === "operator-surface");
    assert.match(check.detail, /the control plane saw 203\.0\.113\.7/);
    assert.match(check.fix, /^add 203\.0\.113\.7 to CLOUD_ADMIN_ALLOWED_IPS/);
    assert.equal(doc.ok, false);
  } finally {
    v.cleanup();
  }
});

test("preflight: a rejected token, no Railway login, an old release and a missing image each name their fix", async () => {
  const w = world({ railwayLoggedIn: false, ghcrTags: [] });
  w.cp.token = "a-different-token";
  try {
    assert.equal(await w.run(["preflight", "--release", RELEASE]), 1);
    const out = w.output();
    assert.match(out, /\[FAIL\] operator-surface: the control plane refused the admin token \(401\)/);
    assert.match(out, /fix: replace it .* security add-generic-password -U -s agentdash-cloud-admin-token/);
    assert.match(out, /\[FAIL\] railway: `railway whoami` failed: not logged in\n\s+fix: railway login/);
    assert.match(out, /\[FAIL\] release: no image at ghcr\.io\/thetangstr\/agentdash:v2026\.1030\.0\n\s+fix: .*gh workflow run docker\.yml --ref main -f release_tag=v2026\.1030\.0/);
  } finally {
    w.cleanup();
  }
  const v = world();
  try {
    assert.equal(await v.run(["preflight", "--release", "v2026.925.0"]), 1);
    assert.match(v.output(), /\[FAIL\] release: v2026\.925\.0 is older than v2026\.929\.0/);
  } finally {
    v.cleanup();
  }
});

test("preflight: all green reads the token from the Keychain, checks GHCR and the provider item, and leaks nothing", async () => {
  const w = world({ keychain: { "agentdash-provider-zai": PROVIDER_KEY, "agentdash-source-token": SOURCE_TOKEN } });
  try {
    assert.equal(await w.run(["preflight", "--release", RELEASE, "--provider", "zai", "--from", SRC]), 0, w.output());
    const out = w.output();
    assert.match(out, /\[ok\] admin-token: from Keychain item agentdash-cloud-admin-token/);
    assert.match(out, /\[ok\] operator-surface: reachable and authorized/);
    assert.match(out, /\[ok\] railway: ops@agentdash\.cloud/);
    assert.match(out, /\[ok\] release: ghcr\.io\/thetangstr\/agentdash:v2026\.1030\.0/);
    assert.match(out, /\[ok\] provider: Keychain item agentdash-provider-zai present/);
    assert.match(out, /preflight passed/);
    const providerReads = w.execs((e) => e.cmd === "security" && e.args.includes("agentdash-provider-zai"));
    assert.ok(providerReads.every((e) => !e.args.includes("-w")), "preflight checks the provider item exists without reading the key");
    const cpCalls = w.fetches((e) => e.url.startsWith(CP));
    assert.deepEqual(cpCalls.map((e) => `${e.method} ${e.url}`), [`GET ${CP}/internal/settings`], "one read-only operator call");
    assertNoSecrets(w);
  } finally {
    w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create: a new slug is created once with purpose internal, then polled until healthy", async () => {
  const w = world();
  try {
    assert.equal(await w.run(["create", SLUG, "--email", EMAIL, "--release", RELEASE]), 0, w.output());
    const posts = w.fetches((e) => e.method === "POST" && e.url === `${CP}/internal/boxes`);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, { slug: SLUG, email: EMAIL, releaseTag: RELEASE, purpose: "internal" });
    assert.match(w.output(), /\[waiting\] provisioning: box provisioning, job (queued|running)/);
    assert.match(w.output(), /\[ok\] healthy: ibox is awaiting_claim at https:\/\/ibox\.agentdash\.cloud, release v2026\.1030\.0/);
    // Idempotent: a second run reports the box and posts nothing.
    w.reset();
    assert.equal(await w.run(["create", SLUG, "--email", EMAIL, "--release", RELEASE, "--json"]), 0, w.output());
    assert.equal(w.fetches((e) => e.method === "POST").length, 0, "an existing box is never recreated");
    const doc = JSON.parse(w.stdout());
    assert.equal(doc.ok, true);
    assert.equal(doc.steps[0].status, "exists");
    assert.equal(doc.result.state, "awaiting_claim");
    assertNoSecrets(w);
  } finally {
    w.cleanup();
  }
});

test("create: a customer box with the slug is refused, --dry-run posts nothing, a failed box resumes through retry", async () => {
  const w = world({ boxes: [internalBox({ purpose: "customer", state: "active" })] });
  try {
    assert.equal(await w.run(["create", SLUG, "--email", EMAIL, "--release", RELEASE]), 1);
    assert.match(w.output(), /slug ibox is taken by a customer box; refusing to touch it/);
    assert.equal(w.fetches((e) => e.method === "POST").length, 0);
  } finally {
    w.cleanup();
  }
  const d = world();
  try {
    assert.equal(await d.run(["create", SLUG, "--email", EMAIL, "--release", RELEASE, "--dry-run"]), 0);
    assert.equal(d.fetches((e) => e.method === "POST").length, 0);
    assert.match(d.output(), /\[planned\] create: POST \/internal\/boxes/);
  } finally {
    d.cleanup();
  }
  const f = world({ boxes: [internalBox({ state: "failed", publicUrl: null })], jobs: [{ id: "j-ibox", slug: SLUG, kind: "provision", state: "failed", step: "deploy", attempt: 3, lastError: "boom", createdAt: "2026-10-31T10:00:00.000Z" }] });
  try {
    assert.equal(await f.run(["create", SLUG, "--email", EMAIL, "--release", RELEASE]), 0, f.output());
    assert.equal(f.fetches((e) => e.method === "POST" && e.url.endsWith("/retry")).length, 1);
    assert.equal(f.fetches((e) => e.method === "POST" && e.url === `${CP}/internal/boxes`).length, 0);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

test("claim: password in the Keychain before the account exists; sign-up closed and redeployed; no secret printed or on argv", async () => {
  const w = world({ boxes: [internalBox()] });
  try {
    const code = await w.run(["claim", SLUG, "--name", "Ops Founder", "--email", EMAIL]);
    assert.equal(code, 0, w.output());
    const password = w.keychain.get("agentdash-box-ibox-founder");
    assert.ok(password && password.length === 40, "a strong password is stored");
    const writeAt = w.log.findIndex((e) => e.kind === "exec" && e.cmd === "security" && e.args[0] === "-i");
    const signupAt = w.log.findIndex((e) => e.kind === "fetch" && e.url === `${BOX}/api/auth/sign-up/email` && e.body?.inviteCode);
    assert.ok(writeAt >= 0 && signupAt > writeAt, "the Keychain write happens before the account is created");
    const readBack = w.log.findIndex((e, i) => i > writeAt && e.kind === "exec" && e.args.includes("agentdash-box-ibox-founder") && e.args.includes("-w"));
    assert.ok(readBack > writeAt && readBack < signupAt, "the stored password is read back before sign-up");
    assert.deepEqual(w.log[signupAt].body, { name: "Ops Founder", email: EMAIL, password, inviteCode: CLAIM_CODE });
    assert.equal(w.rail.redeploys, 1, "the closed sign-up is made live with a redeploy (runbook §7)");
    assert.equal(w.box.signUpDisabled, true);
    assert.match(w.output(), /\[ok\] close-signup: control plane set PAPERCLIP_AUTH_DISABLE_SIGN_UP=true and rotated the invite code/);
    assert.match(w.output(), /\[ok\] verify: sign-up without a code is refused \(HTTP 403\)/);
    const st = w.state();
    assert.equal(st.founderEmail, EMAIL);
    assert.equal(st.boxUrl, BOX);
    assert.ok(st.signupClosedAt);
    assert.ok(!JSON.stringify(st).includes(password), "the state file holds no secret");
    assertNoSecrets(w, [password]);
    // Resumable: a re-run signs in with the stored password and creates nothing.
    w.reset();
    assert.equal(await w.run(["claim", SLUG, "--name", "Ops Founder", "--email", EMAIL, "--json"]), 0, w.output());
    assert.equal(w.fetches((e) => e.url.endsWith("/sign-up/email") && e.body?.inviteCode).length, 0);
    assert.equal(w.execs((e) => e.args[0] === "-i").length, 0, "no second Keychain write");
    assert.equal(w.box.users.length, 1);
    assertNoSecrets(w, [password]);
  } finally {
    w.cleanup();
  }
});

test("claim: --no-redeploy, then a plain re-run, finishes with the redeploy (the code already rotated)", async () => {
  const w = world({ boxes: [internalBox()] });
  try {
    assert.equal(await w.run(["claim", SLUG, "--name", "Ops", "--email", EMAIL, "--no-redeploy"]), 0, w.output());
    assert.equal(w.rail.redeploys, 0);
    assert.match(w.output(), /\[skipped\] redeploy: the closed sign-up goes live at the box's next deploy/);
    assert.equal(w.box.signUpDisabled, false, "configured, not yet live");
    w.reset();
    assert.equal(await w.run(["claim", SLUG, "--name", "Ops", "--email", EMAIL]), 0, w.output());
    assert.equal(w.rail.redeploys, 1);
    assert.equal(w.box.signUpDisabled, true);
    assert.equal(w.box.users.length, 1);
    assertNoSecrets(w, [w.keychain.get("agentdash-box-ibox-founder")]);
  } finally {
    w.cleanup();
  }
});

test("claim: a claim email that does not match the box is refused before the Keychain or the box is touched", async () => {
  const w = world({ boxes: [internalBox()] });
  try {
    assert.equal(await w.run(["claim", SLUG, "--name", "X", "--email", "someone@agentdash.cloud"]), 1);
    assert.match(w.output(), /the box's claim is bound to ops@agentdash\.cloud, not someone@agentdash\.cloud/);
    assert.equal(w.execs((e) => e.args[0] === "-i").length, 0);
    assert.equal(w.fetches((e) => e.url.endsWith("/sign-up/email")).length, 0);
    assertNoSecrets(w);
  } finally {
    w.cleanup();
  }
});

test("claim: a failed Keychain write stops before the account is created; a box claimed by someone else is left alone", async () => {
  const w = world({ boxes: [internalBox()], keychainWriteFails: true });
  try {
    assert.equal(await w.run(["claim", SLUG, "--name", "X", "--email", EMAIL]), 1);
    assert.match(w.output(), /could not store the password in the Keychain item agentdash-box-ibox-founder; nothing was created on the box/);
    assert.equal(w.fetches((e) => e.url.endsWith("/sign-up/email")).length, 0);
    assert.equal(w.box.users.length, 0);
  } finally {
    w.cleanup();
  }
  const v = world({ boxes: [internalBox({ state: "active" })], boxUsers: [{ email: "other@x.test", password: "p", name: "o" }] });
  try {
    assert.equal(await v.run(["claim", SLUG, "--name", "X", "--email", EMAIL]), 1);
    assert.match(v.output(), /already claimed, and not by this tool/);
    assert.equal(v.execs((e) => e.args[0] === "-i").length, 0);
  } finally {
    v.cleanup();
  }
});

test("claim: --dry-run plans without writing; a slow control plane times out with a resume instruction", async () => {
  const w = world({ boxes: [internalBox()] });
  try {
    assert.equal(await w.run(["claim", SLUG, "--name", "X", "--email", EMAIL, "--dry-run"]), 0, w.output());
    assert.equal(w.execs((e) => e.args[0] === "-i").length, 0);
    assert.equal(w.fetches((e) => e.method === "POST").length, 0);
    assert.match(w.output(), /\[planned\] password: generate a password and store it in the Keychain item agentdash-box-ibox-founder/);
  } finally {
    w.cleanup();
  }
  const s = world({ boxes: [internalBox()], closeSignupNeverRuns: true });
  try {
    assert.equal(await s.run(["claim", SLUG, "--name", "X", "--email", EMAIL, "--timeout", "1"]), 1);
    assert.match(s.output(), /has not closed sign-up yet .*fix: re-run claim ibox to keep waiting/s);
    assert.equal(s.box.users.length, 1, "the account exists; a re-run resumes from here");
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// move-company
// ---------------------------------------------------------------------------

async function claimedWorld(opts = {}) {
  const w = world({ boxes: [internalBox()], keychain: { "agentdash-source-token": SOURCE_TOKEN, "agentdash-provider-zai": PROVIDER_KEY }, ...opts });
  assert.equal(await w.run(["claim", SLUG, "--name", "Ops", "--email", EMAIL]), 0, w.output());
  w.reset();
  return w;
}

const BOX_WRITES = (e) => e.url.startsWith(BOX) && e.method !== "GET" && !e.url.endsWith("/api/auth/sign-in/email") && !e.url.endsWith("/import/preview");

test("move-company: the default dry run writes nothing to the box and shows the Hermes plan and the goal gap", async () => {
  const w = await claimedWorld();
  try {
    assert.equal(await w.run(["move-company", "--from", SRC, "--to", SLUG, "--company", "Acme", "--json"]), 0, w.output());
    assert.deepEqual(w.fetches(BOX_WRITES), [], "a dry run makes no writes");
    const doc = JSON.parse(w.stdout());
    assert.equal(doc.dryRun, true);
    assert.deepEqual(doc.result.bundle, { agents: 2, projects: 1, issues: 2, routines: 1, skills: 0, goals: 0 });
    assert.deepEqual(doc.result.hermes.map((a) => [a.slug, a.from, a.switches]), [["cos", "claude_local", true], ["eng", "hermes_local", false]]);
    assert.deepEqual(doc.result.issueOverrides.map((i) => i.slug), ["i1"]);
    assert.ok(doc.warnings.some((m) => /1 goals will NOT move/.test(m)));
    assert.equal(w.box.companies.length, 0);
    assertNoSecrets(w, [w.keychain.get("agentdash-box-ibox-founder")]);
  } finally {
    w.cleanup();
  }
});

test("move-company --apply: imports with every agent on hermes_local, clears issue overrides, verifies, and never imports twice", async () => {
  const w = await claimedWorld();
  try {
    assert.equal(await w.run(["move-company", "--from", SRC, "--to", SLUG, "--company", "c0000000-0000-4000-8000-000000000001", "--apply"]), 0, w.output());
    const imports = w.fetches((e) => e.url === `${BOX}/api/companies/import`);
    assert.equal(imports.length, 1);
    assert.deepEqual(imports[0].body.adapterOverrides, { cos: { adapterType: "hermes_local", adapterConfig: {} }, eng: { adapterType: "hermes_local", adapterConfig: {} } });
    assert.deepEqual(imports[0].body.target, { mode: "existing_company", companyId: "tc000000-0000-4000-8000-000000000009" });
    assert.ok(w.box.agents.every((a) => a.adapterType === "hermes_local" && Object.keys(a.adapterConfig).length === 0));
    const i1 = w.box.issues.find((i) => i.identifier === "ACM-1");
    assert.deepEqual(i1.assigneeAdapterOverrides, { modelProfile: "fast" }, "the other adapter's config is dropped, the model profile kept");
    assert.match(w.output(), /\[ok\] verify agents: source 2, bundle 2, box 2/);
    assert.match(w.output(), /\[ok\] verify issues: source 2, bundle 2, box 2/);
    assert.match(w.output(), /\[gap\] verify goals: source 1, bundle 0, box 0 \(the portability bundle does not carry goals\)/);
    const move = Object.values(w.state().moves)[0];
    assert.ok(move.imported && move.verified);
    // Re-running --apply re-verifies without a second import.
    w.reset();
    assert.equal(await w.run(["move-company", "--from", SRC, "--to", SLUG, "--company", "Acme", "--apply"]), 0, w.output());
    assert.equal(w.fetches((e) => e.url === `${BOX}/api/companies/import`).length, 0);
    assert.equal(w.fetches((e) => e.method === "POST" && e.url === `${BOX}/api/companies`).length, 0);
    assert.equal(w.box.agents.length, 2);
    assertNoSecrets(w, [w.keychain.get("agentdash-box-ibox-founder")]);
  } finally {
    w.cleanup();
  }
});

test("move-company --apply: switches an agent the import left on another adapter and strips host-execution keys", async () => {
  const w = await claimedWorld();
  try {
    w.box.companies.push({ id: "tc000000-0000-4000-8000-000000000009", name: "Acme" });
    w.box.instanceAdmin = EMAIL;
    // A run that imported (without overrides) and died before recording it.
    w.box.agents.push({ id: "ta-cos", name: "CoS", status: "idle", adapterType: "claude_local", adapterConfig: { command: "/usr/local/bin/claude", env: { X: "1" }, model: "m" } });
    w.box.agents.push({ id: "ta-eng", name: "Eng", status: "idle", adapterType: "hermes_local", adapterConfig: {} });
    w.box.projects.push({ id: "tp-web", name: "Web" });
    w.box.issues.push({ id: "ti-i1", identifier: "ACM-1", assigneeAdapterOverrides: null }, { id: "ti-i2", identifier: "ACM-2", assigneeAdapterOverrides: null });
    assert.equal(await w.run(["move-company", "--from", SRC, "--to", SLUG, "--company", "Acme", "--apply"]), 0, w.output());
    assert.equal(w.fetches((e) => e.url === `${BOX}/api/companies/import`).length, 0, "matching data is adopted, not imported again");
    const cos = w.box.agents.find((a) => a.id === "ta-cos");
    assert.equal(cos.adapterType, "hermes_local");
    assert.deepEqual(Object.keys(cos.adapterConfig).filter((k) => ["command", "env", "args", "cwd"].includes(k)), []);
  } finally {
    w.cleanup();
  }
});

test("move-company: a second source company is refused once the box holds a moved one", async () => {
  const w = await claimedWorld();
  try {
    assert.equal(await w.run(["move-company", "--from", SRC, "--to", SLUG, "--company", "Acme", "--apply"]), 0, w.output());
    w.reset();
    assert.equal(await w.run(["move-company", "--from", SRC, "--to", SLUG, "--company", "Other", "--apply"]), 1);
    assert.match(w.output(), /was moved here from Acme; a hosted box holds one company/);
    assert.deepEqual(w.fetches(BOX_WRITES), []);
  } finally {
    w.cleanup();
  }
});

test("move-company: a box company with data this tool did not import is refused", async () => {
  const w = await claimedWorld();
  try {
    w.box.companies.push({ id: "tc000000-0000-4000-8000-000000000009", name: "Someone else" });
    w.box.agents.push({ id: "x", name: "X", status: "idle", adapterType: "hermes_local", adapterConfig: {} });
    assert.equal(await w.run(["move-company", "--from", SRC, "--to", SLUG, "--company", "Acme", "--apply"]), 1);
    assert.match(w.output(), /already holds Someone else with data this tool did not record importing/);
    assert.deepEqual(w.fetches(BOX_WRITES), []);
  } finally {
    w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// configure
// ---------------------------------------------------------------------------

test("configure: the provider key comes from the Keychain, reaches only the box's setup route, and is never printed", async () => {
  const w = await claimedWorld();
  try {
    assert.equal(await w.run(["configure", SLUG, "--provider", "zai"]), 1, "no company yet");
    assert.match(w.output(), /the box has no company yet/);
    await w.run(["move-company", "--from", SRC, "--to", SLUG, "--company", "Acme", "--apply"]);
    w.reset();
    assert.equal(await w.run(["configure", SLUG, "--provider", "zai", "--dry-run"]), 0, w.output());
    assert.equal(w.fetches((e) => e.url.endsWith("/setup-adapter")).length, 0);
    assert.equal(w.execs((e) => e.args.includes("agentdash-provider-zai") && e.args.includes("-w")).length, 0, "a dry run never reads the key");
    w.reset();
    assert.equal(await w.run(["configure", SLUG, "--provider", "zai"]), 0, w.output());
    const calls = w.fetches((e) => e.url.endsWith("/api/onboarding/setup-adapter"));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { preset: "hermes", provider: "zai", apiKey: PROVIDER_KEY, companyId: "tc000000-0000-4000-8000-000000000009" });
    assert.equal(w.box.provider.apiKey, PROVIDER_KEY);
    assertNoSecrets(w, [w.keychain.get("agentdash-box-ibox-founder")]);
    // Idempotent: configured with the same provider, nothing is sent again.
    w.reset();
    assert.equal(await w.run(["configure", SLUG, "--provider", "zai"]), 0);
    assert.equal(w.fetches((e) => e.url.endsWith("/setup-adapter")).length, 0);
    assert.match(w.output(), /\[exists\] provider: zai already configured/);
  } finally {
    w.cleanup();
  }
});

// ---------------------------------------------------------------------------
// status, arguments, helpers
// ---------------------------------------------------------------------------

test("status: health, release, purpose and backups, as text and as JSON", async () => {
  const backups = [
    { id: "bk2", state: "failed", startedAt: "2026-10-31T08:00:00.000Z", finishedAt: null, error: "token_pending_deploy", prunedAt: null },
    { id: "bk1", state: "succeeded", startedAt: "2026-10-30T08:00:00.000Z", finishedAt: "2026-10-30T08:01:00.000Z", sizeBytes: 1024, release: RELEASE, prunedAt: null },
  ];
  const w = world({ boxes: [internalBox({ state: "active", claimedAt: "2026-10-31T11:00:00.000Z" })], backups });
  try {
    assert.equal(await w.run(["status", SLUG]), 0, w.output());
    const out = w.stdout();
    assert.match(out, /^box\s+ibox  purpose internal  state active  release v2026\.1030\.0$/m);
    assert.match(out, /^health\s+direct ok, router ok$/m);
    assert.match(out, /^backups\s+1 kept; latest good 2026-10-30T08:01:00\.000Z \(28 h ago\); last attempt failed: token_pending_deploy$/m);
    w.reset();
    assert.equal(await w.run(["status", SLUG, "--json"]), 0);
    const doc = JSON.parse(w.stdout());
    assert.equal(doc.result.box.purpose, "internal");
    assert.equal(doc.result.backups.count, 1);
    assert.equal(doc.result.backups.latestGood.id, "bk1");
  } finally {
    w.cleanup();
  }
  assert.deepEqual(summarizeBackups([], 0), { count: 0, latestGood: null, latestAttempt: null });
  const lines = formatStatus({ box: { slug: "s", purpose: "internal", state: "awaiting_claim", releaseTag: null, holdUpgrades: true, publicUrl: null, claimedAt: null }, health: { paths: [] }, backups: { count: 0, latestGood: null, latestAttempt: null }, local: {} });
  assert.match(lines.join("\n"), /\(upgrades held\)[\s\S]*no polls yet[\s\S]*latest good none/);
});

test("arguments: secret-looking flags are refused, unknown options and commands are usage errors", async () => {
  for (const flag of ["--password", "--token=abc", "--api-key", "--code", "--admin-token"]) {
    assert.throws(() => parseArgs(["claim", "x", flag, "v"]), /secrets are never taken on the command line/);
  }
  const w = world();
  try {
    assert.equal(await w.run(["claim", SLUG, "--password", "hunter2hunter2"]), 64);
    assert.ok(!w.output().includes("hunter2hunter2"));
    assert.equal(await w.run(["nope"]), 64);
    assert.equal(await w.run(["status", SLUG, "--bogus"]), 64);
    assert.equal(await w.run(["--help"]), 0);
  } finally {
    w.cleanup();
  }
});

test("helpers: passwords, the Hermes plan, bundle counts and verification", () => {
  const a = newPassword();
  const b = newPassword();
  assert.match(a, /^[A-Za-z0-9]{40}$/);
  assert.notEqual(a, b);
  const { manifest } = sourceCompany().bundle;
  assert.deepEqual(bundleCounts(manifest), { agents: 2, projects: 1, issues: 2, routines: 1, skills: 0, goals: 0 });
  assert.equal(Object.keys(hermesPlan(manifest).adapterOverrides).length, 2);
  const rows = verifyCounts({ agents: 2, projects: 1, issues: 2, goals: 0 }, bundleCounts(manifest), { agents: 2, projects: 1, issues: 1, goals: 0 });
  assert.equal(rows.find((r) => r.entity === "issues").ok, false);
  assert.equal(rows.find((r) => r.entity === "goals").ok, true);
});

// ---------------------------------------------------------------------------
// The real process: spawn, `security -i` on stdin, and the operator CLI over HTTP
// ---------------------------------------------------------------------------

function fakeBin(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

test("real exec: the Keychain write puts the password on stdin, never on argv", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "internal-box-exec-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  fakeBin(bin, "security", `#!/usr/bin/env node
const fs = require("node:fs");
const dir = ${JSON.stringify(root)};
fs.appendFileSync(dir + "/argv.log", process.argv.slice(2).join(" ") + "\\n");
const store = dir + "/store.json";
const db = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : {};
const a = process.argv.slice(2);
if (a[0] === "-i") {
  const input = fs.readFileSync(0, "utf8");
  fs.appendFileSync(dir + "/stdin.log", input);
  for (const line of input.split("\\n").filter(Boolean)) { const t = line.trim().split(/\\s+/); db[t[t.indexOf("-s") + 1]] = t[t.indexOf("-w") + 1]; }
  fs.writeFileSync(store, JSON.stringify(db));
  process.exit(0);
}
const svc = a[a.indexOf("-s") + 1];
if (!(svc in db)) process.exit(44);
if (a.includes("-w")) process.stdout.write(db[svc] + "\\n");
process.exit(0);
`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    // A claim run whose only real child process is the fake `security` (the admin token from env).
    const w = world({ boxes: [internalBox()], env: { CLOUD_ADMIN_TOKEN: ADMIN } });
    const exec = w.deps.exec;
    w.deps.exec = (cmd, args, o) => (cmd === "security" ? realExec(cmd, args, o) : exec(cmd, args, o));
    try {
      assert.equal(await w.run(["claim", SLUG, "--name", "Ops", "--email", EMAIL, "--no-wait"]), 0, w.output());
      const stored = JSON.parse(readFileSync(path.join(root, "store.json"), "utf8"))["agentdash-box-ibox-founder"];
      assert.match(stored, /^[A-Za-z0-9]{40}$/);
      assert.ok(readFileSync(path.join(root, "stdin.log"), "utf8").includes(stored), "the password travelled on stdin");
      assert.ok(!readFileSync(path.join(root, "argv.log"), "utf8").includes(stored), "the password was never on argv");
      assert.equal(w.box.users[0].password, stored);
    } finally {
      w.cleanup();
    }
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI as a process: preflight against a local control plane, token from a fake Keychain", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "internal-box-cli-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  fakeBin(bin, "security", `#!/bin/sh\necho "security $*" >> "${root}/argv.log"\ncase "$*" in *agentdash-cloud-admin-token*-w*) printf '%s\\n' '${ADMIN}'; exit 0;; esac\nexit 44\n`);
  fakeBin(bin, "railway", `#!/bin/sh\necho "railway $*" >> "${root}/argv.log"\n[ "$1" = whoami ] && echo "Logged in as ops@agentdash.cloud"\nexit 0\n`);
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${ADMIN}` ? "authorized" : "no-auth"}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ provisioning_enabled: true }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    // Asynchronous spawn: the fake control plane runs on this process's event loop.
    const child = await new Promise((resolve) => {
      const c = spawn("node", [SCRIPT, "preflight", "--json"], {
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, CLOUD_CONTROL_URL: `http://127.0.0.1:${port}`, AGENTDASH_BOX_STATE_DIR: path.join(root, "state") },
      });
      let stdout = "";
      let stderr = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stderr += d));
      c.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(child.status, 0, child.stderr);
    const doc = JSON.parse(child.stdout);
    assert.equal(doc.ok, true);
    assert.deepEqual(seen, ["GET /internal/settings authorized"]);
    assert.ok(!child.stdout.includes(ADMIN) && !child.stderr.includes(ADMIN));
    assert.ok(!readFileSync(path.join(root, "argv.log"), "utf8").includes(ADMIN), "the token never reached a command line");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
