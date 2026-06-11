import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "msp-partner-access-proof.sh");

function withFakeCurl(companiesJson, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdash-partner-proof-test-"));
  const fakeCurlPath = path.join(dir, "curl");
  writeFileSync(
    fakeCurlPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let output = null;
let url = "";
let cookieMode = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "-o") {
    output = args[index + 1];
    index += 1;
  } else if (arg === "-b" || arg === "-c") {
    cookieMode = true;
    index += 1;
  } else if (arg === "-w" || arg === "-H" || arg === "-X" || arg === "--data") {
    index += 1;
  } else if (arg.startsWith("http://") || arg.startsWith("https://")) {
    url = arg;
  }
}

let status = "404";
let body = "{}";
if (url.endsWith("/api/health")) {
  status = "200";
  body = JSON.stringify({ deploymentMode: "authenticated", bootstrapStatus: "ready", bootstrapInviteActive: false });
} else if (url.endsWith("/api/auth/sign-in/email")) {
  status = "200";
  body = JSON.stringify({ ok: true });
} else if (url.endsWith("/api/auth/get-session")) {
  status = cookieMode ? "200" : "401";
  body = cookieMode ? JSON.stringify({ userId: "user-1" }) : JSON.stringify({ error: "unauthorized" });
} else if (url.endsWith("/api/companies")) {
  status = cookieMode ? "200" : "403";
  body = cookieMode ? process.env.FAKE_COMPANIES_JSON : JSON.stringify({ error: "forbidden" });
} else if (url.endsWith("/")) {
  status = "200";
  body = '<html><div id="root"></div><script src="/assets/app.js"></script></html>';
}

if (output) {
  fs.writeFileSync(output, body);
}
process.stdout.write(status);
`,
  );
  chmodSync(fakeCurlPath, 0o755);

  try {
    return fn({
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        FAKE_COMPANIES_JSON: companiesJson,
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runPartnerProof(args, env) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

const proofArgs = [
  "--base-url",
  "http://10.0.0.5:3100",
  "--email",
  "proof@example.com",
  "--password",
  "secret",
];

test("passes when the expected company is visible after login", () => {
  withFakeCurl(JSON.stringify([{ id: "company-1", name: "Acme MSP" }]), ({ env }) => {
    const result = runPartnerProof([...proofArgs, "--expected-company", "Acme MSP"], env);

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Expected company is visible after login: Acme MSP/);
    assert.match(result.stdout, /Status: Partner-device access proof passed\./);
  });
});

test("fails when the expected company is not visible after login", () => {
  withFakeCurl(JSON.stringify([{ id: "company-2", name: "Other Company" }]), ({ env }) => {
    const result = runPartnerProof([...proofArgs, "--expected-company", "Acme MSP"], env);

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Expected company was not visible after login: Acme MSP/);
    assert.match(result.stdout, /Status: NOT READY for partner-device launch proof\./);
  });
});
