import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPartnerAccessProofPlan,
  companyMatchesExpected,
  normalizeBaseUrl,
  readCookieHeaderFromJar,
  summarizeProof,
} from "./msp-partner-access-proof.mjs";

test("normalizes base URLs and expected API endpoints", () => {
  const plan = buildPartnerAccessProofPlan({
    baseUrl: "http://100.64.0.10:3100/",
    expectedCompany: "AgentDash MSP Demo",
    email: "operator@example.com",
    password: "secret",
  });

  assert.equal(normalizeBaseUrl("http://100.64.0.10:3100/"), "http://100.64.0.10:3100");
  assert.equal(plan.healthUrl, "http://100.64.0.10:3100/api/health");
  assert.equal(plan.signInUrl, "http://100.64.0.10:3100/api/auth/sign-in/email");
  assert.equal(plan.companiesUrl, "http://100.64.0.10:3100/api/companies");
  assert.equal(plan.authMode, "credentials");
});

test("supports cookie-jar proof without requiring credentials", () => {
  const plan = buildPartnerAccessProofPlan({
    baseUrl: "http://100.64.0.10:3100",
    expectedCompany: "AgentDash MSP Demo",
    cookieJar: "/tmp/agentdash.cookies",
  });

  assert.equal(plan.authMode, "cookie_jar");
});

test("reads a Netscape cookie jar into a Cookie header", () => {
  const header = readCookieHeaderFromJar([
    "# Netscape HTTP Cookie File",
    "100.64.0.10\tFALSE\t/\tFALSE\t0\tbetter-auth.session_token\tabc123",
    "100.64.0.10\tFALSE\t/\tFALSE\t0\tother\tvalue",
    "",
  ].join("\n"));

  assert.equal(header, "better-auth.session_token=abc123; other=value");
});

test("requires either credentials or a cookie jar", () => {
  assert.throws(
    () => buildPartnerAccessProofPlan({
      baseUrl: "http://100.64.0.10:3100",
      expectedCompany: "AgentDash MSP Demo",
    }),
    /credentials or --cookie-jar/,
  );
});

test("matches expected company by name", () => {
  assert.equal(
    companyMatchesExpected([
      { id: "1", name: "AgentDash MSP Demo" },
      { id: "2", name: "Other" },
    ], "AgentDash MSP Demo"),
    true,
  );
  assert.equal(companyMatchesExpected([{ id: "1", name: "Other" }], "AgentDash MSP Demo"), false);
});

test("summarizes proof failures", () => {
  const summary = summarizeProof([
    { name: "health", status: "pass", detail: "ok" },
    { name: "company_visible", status: "fail", detail: "missing" },
  ]);

  assert.equal(summary.pass, 1);
  assert.equal(summary.fail, 1);
});
