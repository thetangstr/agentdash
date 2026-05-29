#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

function nowIso() {
  return new Date().toISOString();
}

export function normalizeBaseUrl(value) {
  if (!value || typeof value !== "string") {
    throw new Error("--base-url is required");
  }
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function buildPartnerAccessProofPlan(input = {}) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!input.expectedCompany) {
    throw new Error("--expected-company is required");
  }
  const hasCredentials = Boolean(input.email && input.password);
  const hasCookieJar = Boolean(input.cookieJar);
  if (!hasCredentials && !hasCookieJar) {
    throw new Error("Partner proof requires credentials or --cookie-jar");
  }
  return {
    baseUrl,
    expectedCompany: input.expectedCompany,
    email: input.email ?? null,
    password: input.password ?? null,
    cookieJar: input.cookieJar ?? null,
    authMode: hasCredentials ? "credentials" : "cookie_jar",
    healthUrl: `${baseUrl}/api/health`,
    signInUrl: `${baseUrl}/api/auth/sign-in/email`,
    sessionUrl: `${baseUrl}/api/auth/get-session`,
    companiesUrl: `${baseUrl}/api/companies`,
  };
}

export function companyMatchesExpected(companies, expectedCompany) {
  return Array.isArray(companies)
    && companies.some((company) =>
      company
      && typeof company === "object"
      && String(company.name ?? "").trim() === expectedCompany);
}

export function summarizeProof(checks) {
  return checks.reduce(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
}

function cookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export function readCookieHeaderFromJar(content) {
  const cookies = [];
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("\t");
    if (parts.length >= 7) {
      const name = parts[5];
      const value = parts.slice(6).join("\t");
      if (name && value) cookies.push({ name, value });
      continue;
    }
    const cookieParts = trimmed.split(/;\s*/);
    for (const part of cookieParts) {
      const index = part.indexOf("=");
      if (index <= 0) continue;
      cookies.push({ name: part.slice(0, index), value: part.slice(index + 1) });
    }
  }
  return cookieHeader(cookies);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON from ${url}; received: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
  }
  return { body, headers: response.headers };
}

function parseSetCookie(headers) {
  const raw = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : headers.get("set-cookie")
      ? [headers.get("set-cookie")]
      : [];
  return raw
    .filter(Boolean)
    .map((line) => {
      const first = String(line).split(";")[0] ?? "";
      const index = first.indexOf("=");
      if (index <= 0) return null;
      return { name: first.slice(0, index), value: first.slice(index + 1) };
    })
    .filter(Boolean);
}

export async function runPartnerAccessProof(input = {}) {
  const plan = buildPartnerAccessProofPlan(input);
  const checks = [];
  const cookies = [];
  let cookieJarHeader = "";

  try {
    const { body } = await fetchJson(plan.healthUrl);
    checks.push({
      name: "health",
      status: body?.status === "ok" ? "pass" : "fail",
      detail: `status=${String(body?.status ?? "missing")}`,
    });
  } catch (error) {
    checks.push({
      name: "health",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (plan.authMode === "credentials") {
    try {
      const { headers } = await fetchJson(plan.signInUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: plan.baseUrl,
        },
        body: JSON.stringify({ email: plan.email, password: plan.password }),
      });
      cookies.push(...parseSetCookie(headers));
      checks.push({ name: "sign_in", status: "pass", detail: `signed in ${plan.email}` });
    } catch (error) {
      checks.push({
        name: "sign_in",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    try {
      cookieJarHeader = readCookieHeaderFromJar(readFileSync(plan.cookieJar, "utf8"));
      checks.push({
        name: "sign_in",
        status: cookieJarHeader ? "pass" : "fail",
        detail: cookieJarHeader ? `using cookie jar ${plan.cookieJar}` : `cookie jar has no usable cookies: ${plan.cookieJar}`,
      });
    } catch (error) {
      checks.push({
        name: "sign_in",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const headers = {};
    if (cookies.length > 0) headers.Cookie = cookieHeader(cookies);
    if (cookieJarHeader) headers.Cookie = cookieJarHeader;
    const { body } = await fetchJson(plan.companiesUrl, { headers });
    checks.push({
      name: "company_visible",
      status: companyMatchesExpected(body, plan.expectedCompany) ? "pass" : "fail",
      detail: companyMatchesExpected(body, plan.expectedCompany)
        ? `found ${plan.expectedCompany}`
        : `expected company not found: ${plan.expectedCompany}`,
    });
  } catch (error) {
    checks.push({
      name: "company_visible",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    baseUrl: plan.baseUrl,
    expectedCompany: plan.expectedCompany,
    generatedAt: nowIso(),
    summary: summarizeProof(checks),
    checks,
  };
}

function printHuman(result) {
  console.log(`Partner access proof for ${result.baseUrl}`);
  for (const check of result.checks) {
    console.log(`${check.status.toUpperCase()}\t${check.name}\t${check.detail}`);
  }
  console.log(`Summary: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail`);
}

function printHelp() {
  console.log(`Usage:
  scripts/msp-partner-access-proof.sh --base-url <tailnet-url> --expected-company <name> [options]

Options:
  --base-url <url>            Required private AgentDash URL.
  --expected-company <name>   Required company name that must be visible after login.
  --email <email>             Partner/operator email. Can also use AGENTDASH_PROOF_EMAIL.
  --password <password>       Partner/operator password. Can also use AGENTDASH_PROOF_PASSWORD.
  --cookie-jar <path>         Existing cookie jar path for manual browser/session proof marker.
  --json                      Print JSON instead of human text.
  --help                      Show help.
`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      "expected-company": { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      "cookie-jar": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "agentdash-partner-proof-"));
  try {
    const result = await runPartnerAccessProof({
      baseUrl: values["base-url"],
      expectedCompany: values["expected-company"],
      email: values.email ?? process.env.AGENTDASH_PROOF_EMAIL,
      password: values.password ?? process.env.AGENTDASH_PROOF_PASSWORD,
      cookieJar: values["cookie-jar"],
    });

    if (values.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[msp-partner-access-proof] ${error.message}`);
    process.exitCode = 1;
  });
}
