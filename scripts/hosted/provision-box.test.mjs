// Safety tests for scripts/hosted/provision-box.sh (GH #675, review of PR #730).
//
// The script is run against a fake Railway: `curl`, `railway` and `jq` on PATH
// are shims. The curl shim answers Railway GraphQL queries from a scenario and
// records every request; the jq shim logs its argv and runs the real jq. The
// tests prove:
//   - a failed variable read aborts before any write (a re-run must never
//     regenerate the live auth secret / master key / invite code);
//   - a deployed box with a missing secret aborts unless
//     --i-know-this-destroys-secrets is given;
//   - an existing box's secrets are never regenerated;
//   - no generated secret and no Railway token ever appears on a command line;
//   - the script refuses to run under bash -x;
//   - --close-signup turns sign-up off and removes the code file, and a
//     --no-deploy rotation warns that the old code stays valid;
//   - --redeploy paired with a --release that does not match the box's
//     recorded AGENTDASH_RELEASE_TAG refuses (an upgrade attempt that would
//     silently keep the old build), unless --force-redeploy-same-build is
//     given or the release matches (config-only redeploy, e.g. --close-signup).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "provision-box.sh");
const REPO_ROOT = execFileSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"]).toString().trim();
const REAL_JQ = execFileSync("sh", ["-c", "command -v jq"]).toString().trim();
const TOKEN = "fake-railway-token-DO-NOT-LEAK";

const CURL_SHIM = `#!/usr/bin/env node
// Fake curl for the Railway GraphQL API. Anything else: fail.
const fs = require("node:fs");
const args = process.argv.slice(2);
const dir = process.env.FAKE_DIR;
fs.appendFileSync(dir + "/argv.log", "curl " + args.join(" ") + "\\n");
const url = args[args.length - 1];
if (!url.startsWith("http://fake.railway.invalid")) { process.stderr.write("unexpected curl " + url + "\\n"); process.exit(7); }
if (args.includes("--config")) fs.appendFileSync(dir + "/config.log", fs.readFileSync(0, "utf8"));
const dataArg = args[args.indexOf("--data-binary") + 1];
const body = JSON.parse(fs.readFileSync(dataArg.slice(1), "utf8"));
fs.appendFileSync(dir + "/requests.log", JSON.stringify(body) + "\\n");
const q = body.query;
const scenario = JSON.parse(fs.readFileSync(dir + "/scenario.json", "utf8"));
const fail = () => { process.stdout.write('{"errors":[{"message":"boom"}]}'); process.exit(22); };
let data;
if (q.includes("me { workspaces")) data = { me: { workspaces: [{ id: "ws1" }] } };
else if (q.includes("projects(workspaceId")) data = { projects: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: {
  id: "p1", name: "agentdash-box-test",
  environments: { edges: [{ node: { id: "e1", name: "production" } }] },
  services: { edges: [
    { node: { id: "pg1", name: "Database", serviceInstances: { edges: [{ node: { environmentId: "e1", source: { image: "ghcr.io/railwayapp-templates/postgres-ssl:18" } } }] } } },
    { node: { id: "w1", name: "web", serviceInstances: { edges: [{ node: { environmentId: "e1", source: { image: null } } }] } } },
  ] } } }] } };
else if (q.includes("volumes")) data = { project: { volumes: { edges: [{ node: { name: "v", volumeInstances: { edges: [{ node: { id: "vi1", serviceId: "w1", mountPath: "/paperclip" } }] } } }] } } };
else if (q.includes("domains(")) data = { domains: { serviceDomains: [{ domain: "web-test.up.railway.app" }], customDomains: [] } };
else if (q.includes("unrendered:true")) { if (scenario.namesFail) fail(); data = { variables: scenario.vars }; }
else if (q.includes("variables(")) { if (scenario.valuesFail) fail(); data = { variables: scenario.vars }; }
else if (q.includes("deployments(")) data = { deployments: { edges: scenario.deployed ? [{ node: { id: "d1", status: "SUCCESS" } }] : [] } };
else if (q.includes("variableCollectionUpsert")) { fs.writeFileSync(dir + "/upsert.json", JSON.stringify(body.variables)); data = { variableCollectionUpsert: true }; }
else if (q.includes("serviceInstanceUpdate")) data = { serviceInstanceUpdate: true };
else { process.stderr.write("unhandled query " + q + "\\n"); process.exit(9); }
process.stdout.write(JSON.stringify({ data }));
`;

function setup(scenario) {
  const root = mkdtempSync(path.join(os.tmpdir(), "provision-box-test-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  mkdirSync(bin); mkdirSync(path.join(home, ".railway"), { recursive: true });
  writeFileSync(path.join(home, ".railway", "config.json"), JSON.stringify({ user: { token: TOKEN } }));
  writeFileSync(path.join(root, "scenario.json"), JSON.stringify(scenario));
  const shims = {
    curl: CURL_SHIM,
    railway: `#!/bin/sh\necho "railway $*" >> "$FAKE_DIR/argv.log"\n[ "$1" = whoami ] && echo "Logged in as test@example.com"\nexit 0\n`,
    jq: `#!/bin/sh\nprintf 'jq %s\\n' "$*" >> "$FAKE_DIR/argv.log"\nexec "${REAL_JQ}" "$@"\n`,
  };
  for (const [name, body] of Object.entries(shims)) {
    writeFileSync(path.join(bin, name), body); chmodSync(path.join(bin, name), 0o755);
  }
  return { root, bin, home, state: path.join(root, "state") };
}

function run(ctx, args, { bashX = false } = {}) {
  const cmd = bashX ? ["bash", ["-x", SCRIPT, ...args]] : ["bash", [SCRIPT, ...args]];
  return spawnSync(cmd[0], cmd[1], {
    encoding: "utf8",
    env: {
      PATH: `${ctx.bin}:${process.env.PATH}`, HOME: ctx.home, FAKE_DIR: ctx.root,
      AGENTDASH_BOX_STATE_DIR: ctx.state, RAILWAY_GQL_URL: "http://fake.railway.invalid/graphql",
      TMPDIR: ctx.root,
    },
  });
}

const read = (ctx, f) => (existsSync(path.join(ctx.root, f)) ? readFileSync(path.join(ctx.root, f), "utf8") : "");
const BASE = ["--slug", "test", "--release", "v2026.924.0", "--no-deploy"];
const SECRETS = { BETTER_AUTH_SECRET: "live-auth", PAPERCLIP_SECRETS_MASTER_KEY: "live-master", AGENTDASH_INVITE_CODES: "AGD-LIVE" };

test("a failed variable-name read aborts before any write", () => {
  const ctx = setup({ namesFail: true, deployed: true, vars: {} });
  try {
    const r = run(ctx, BASE);
    assert.notEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /could not read the box's current variables/);
    assert.equal(read(ctx, "upsert.json"), "", "no variable write may happen");
    assert.doesNotMatch(r.stderr, /generating/);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("a failed variable-value read aborts before any write", () => {
  const ctx = setup({ valuesFail: true, deployed: true, vars: {} });
  try {
    const r = run(ctx, BASE);
    assert.notEqual(r.status, 0);
    assert.equal(read(ctx, "upsert.json"), "");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("a deployed box missing its master key aborts unless explicitly allowed", () => {
  const vars = { BETTER_AUTH_SECRET: "live-auth", AGENTDASH_INVITE_CODES: "AGD-LIVE" };
  const ctx = setup({ deployed: true, vars });
  try {
    const r = run(ctx, BASE);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /PAPERCLIP_SECRETS_MASTER_KEY is missing/);
    assert.equal(read(ctx, "upsert.json"), "");
    const forced = run(ctx, [...BASE, "--i-know-this-destroys-secrets"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(JSON.parse(read(ctx, "upsert.json")).i.variables.PAPERCLIP_SECRETS_MASTER_KEY);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("an existing box's secrets are never regenerated", () => {
  const ctx = setup({ deployed: true, vars: { ...SECRETS, PAPERCLIP_PUBLIC_URL: "https://web-test.up.railway.app" } });
  try {
    const r = run(ctx, BASE);
    assert.equal(r.status, 0, r.stderr);
    const sent = JSON.parse(read(ctx, "upsert.json")).i.variables;
    for (const k of Object.keys(SECRETS)) assert.equal(sent[k], undefined, `${k} must not be rewritten`);
    assert.equal(sent.AGENTDASH_DEPLOYMENT_KIND, "hosted");
    // The anonymous Test Drive creates a company; a hosted box holds one (#725).
    assert.equal(sent.AGENTDASH_TRIAL_ANONYMOUS, "false");
    assert.equal(sent.DATABASE_URL, "${{Database.DATABASE_URL}}", "Postgres is found by image, not by name");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("a fresh box gets secrets that never touch a command line", () => {
  const ctx = setup({ deployed: false, vars: {} });
  try {
    const r = run(ctx, BASE);
    assert.equal(r.status, 0, r.stderr);
    const sent = JSON.parse(read(ctx, "upsert.json")).i.variables;
    const secrets = [sent.BETTER_AUTH_SECRET, sent.PAPERCLIP_SECRETS_MASTER_KEY, sent.AGENTDASH_INVITE_CODES];
    for (const s of secrets) assert.ok(s && s.length >= 20);
    const argv = read(ctx, "argv.log");
    for (const s of [...secrets, TOKEN]) assert.ok(!argv.includes(s), "a secret appeared on a command line");
    assert.ok(read(ctx, "config.log").includes(TOKEN), "the token reaches curl via --config on stdin");
    const codeFile = path.join(ctx.state, "test", "founder-invite-code.txt");
    assert.equal(readFileSync(codeFile, "utf8").trim(), sent.AGENTDASH_INVITE_CODES);
    assert.equal(readdirSync(path.join(ctx.state, "test")).filter((f) => f.startsWith("secret.")).length, 0, "temp secret files are removed");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("--close-signup disables sign-up, rotates to an unrecorded code, removes the code file", () => {
  const ctx = setup({ deployed: true, vars: { ...SECRETS } });
  try {
    mkdirSync(path.join(ctx.state, "test"), { recursive: true });
    const codeFile = path.join(ctx.state, "test", "founder-invite-code.txt");
    writeFileSync(codeFile, "AGD-LIVE\n");
    const r = run(ctx, [...BASE, "--close-signup"]);
    assert.equal(r.status, 0, r.stderr);
    const sent = JSON.parse(read(ctx, "upsert.json")).i.variables;
    assert.equal(sent.PAPERCLIP_AUTH_DISABLE_SIGN_UP, "true");
    assert.ok(sent.AGENTDASH_INVITE_CODES && sent.AGENTDASH_INVITE_CODES !== "AGD-LIVE");
    assert.equal(existsSync(codeFile), false);
    assert.match(r.stderr, /OLD invite code\s+stays valid/);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("--rotate-invite with --no-deploy warns that the old code stays valid", () => {
  const ctx = setup({ deployed: true, vars: { ...SECRETS } });
  try {
    const r = run(ctx, [...BASE, "--rotate-invite"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /OLD invite code\s+stays valid/);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("refuses to run under bash -x", () => {
  const ctx = setup({ deployed: false, vars: {} });
  try {
    const r = run(ctx, BASE, { bashX: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refusing to run with xtrace/);
    assert.equal(read(ctx, "requests.log"), "", "no API call before the refusal");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("scripts/hosted/*.sh (except lib.sh) are tracked executable", () => {
  const out = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-s", "scripts/hosted/"]).toString();
  const modes = Object.fromEntries(
    out.trim().split("\n").filter(Boolean).map((line) => {
      const [mode, , , file] = line.split(/\s+/);
      return [file, mode];
    }),
  );
  for (const f of ["scripts/hosted/provision-box.sh", "scripts/hosted/claim-box.sh", "scripts/hosted/backup-box.sh"]) {
    assert.equal(modes[f], "100755", `${f} must be tracked as executable (git update-index --chmod=+x)`);
  }
  assert.equal(modes["scripts/hosted/lib.sh"], "100644", "lib.sh is sourced, never executed directly, and must stay non-executable");
});

test("--redeploy with a different --release than the box's recorded tag refuses", () => {
  const ctx = setup({ deployed: true, vars: { ...SECRETS, AGENTDASH_RELEASE_TAG: "v2026.900.0" } });
  try {
    const r = run(ctx, [...BASE, "--redeploy"]); // BASE release is v2026.924.0
    assert.notEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /--redeploy restarts the current build/);
    assert.match(r.stderr, /to upgrade to v2026\.924\.0 run without --redeploy/);
    assert.equal(read(ctx, "upsert.json"), "", "no variable write may happen");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("--force-redeploy-same-build overrides the release-mismatch refusal", () => {
  const ctx = setup({ deployed: true, vars: { ...SECRETS, AGENTDASH_RELEASE_TAG: "v2026.900.0" } });
  try {
    const r = run(ctx, [...BASE, "--redeploy", "--force-redeploy-same-build"]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /--redeploy restarts the current build/);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("--redeploy with the same recorded --release still works (config-only change)", () => {
  const ctx = setup({ deployed: true, vars: { ...SECRETS, AGENTDASH_RELEASE_TAG: "v2026.924.0" } });
  try {
    const r = run(ctx, [...BASE, "--close-signup", "--redeploy"]); // BASE release is v2026.924.0
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /--redeploy restarts the current build/);
    const sent = JSON.parse(read(ctx, "upsert.json")).i.variables;
    assert.equal(sent.PAPERCLIP_AUTH_DISABLE_SIGN_UP, "true");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("--redeploy on a box with no recorded release tag yet is allowed (nothing to compare against)", () => {
  const ctx = setup({ deployed: true, vars: { ...SECRETS } }); // no AGENTDASH_RELEASE_TAG
  try {
    const r = run(ctx, [...BASE, "--redeploy"]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /--redeploy restarts the current build/);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("box slugs are capped at 16 so every box can be restored", () => {
  const ctx = setup({ deployed: false, vars: {} });
  try {
    const long = run(ctx, ["--slug", "acme-corporation-eu", "--release", "v2026.924.0", "--no-deploy"]);
    assert.notEqual(long.status, 0);
    assert.match(long.stderr, /new box slugs are at most 16 chars/);
    assert.ok(!read(ctx, "requests.log").includes("projectCreate"), "no project is created for a too-long slug");
    // The longest allowed box slug, and its restore slug, both pass validation
    // and reach project creation (the fake API does not implement it).
    for (const slug of ["acme-corporation", "acme-corporation-restore"]) {
      const r = run(ctx, ["--slug", slug, "--release", "v2026.924.0", "--no-deploy"]);
      assert.doesNotMatch(r.stderr, /slugs are/, slug);
    }
    assert.equal(read(ctx, "requests.log").split("projectCreate").length - 1, 2, "both reached projectCreate");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});
