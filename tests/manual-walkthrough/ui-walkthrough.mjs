#!/usr/bin/env node
/**
 * The manual UI walkthrough, automated.
 *
 * Every UI finding this project produced came from READING code, and at least
 * one was wrong until a test caught it. This drives a real browser against a
 * live instance so the claims about the UI are observations rather than
 * inferences.
 *
 * Usage:
 *   node tests/manual-walkthrough/ui-walkthrough.mjs [uat|mkboard]
 *
 * It authenticates by minting the same signed better-auth cookie the server
 * issues, reading the secret from the instance env file — the credential is
 * never passed in argv and never printed.
 */
import { chromium } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";

const INSTANCE = process.argv[2] === "mkboard" ? "mkboard" : "uat";
const PORT = INSTANCE === "mkboard" ? 3102 : 3103;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(os.tmpdir(), `agentdash-walkthrough-${INSTANCE}`);

function envValue(key) {
  const raw = readFileSync(path.join(os.homedir(), ".config/agentdash", `${INSTANCE}.env`), "utf8");
  const matches = [...raw.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))];
  return matches.length ? matches[matches.length - 1][1].trim() : null;
}

async function sessionCookie() {
  const sql = postgres(`postgres://paperclip:paperclip@127.0.0.1:54329/${INSTANCE}`, { max: 1 });
  const rows = await sql.unsafe("select token from session order by expires_at desc limit 1");
  await sql.end();
  if (!rows.length) throw new Error(`No session row in ${INSTANCE}; sign in once in a browser first.`);
  const sig = createHmac("sha256", envValue("BETTER_AUTH_SECRET")).update(rows[0].token).digest("base64");
  const prefix = `paperclip-${envValue("PAPERCLIP_INSTANCE_ID").replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
  return { name: `${prefix}.session_token`, value: `${rows[0].token}.${sig}`, domain: "127.0.0.1", path: "/" };
}

async function companyPrefix() {
  const sql = postgres(`postgres://paperclip:paperclip@127.0.0.1:54329/${INSTANCE}`, { max: 1 });
  const rows = await sql.unsafe("select issue_prefix from companies limit 1");
  await sql.end();
  if (!rows.length) throw new Error(`No company in ${INSTANCE}`);
  return String(rows[0].issue_prefix).toLowerCase();
}

const results = [];
function record(step, ok, detail = "") {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([await sessionCookie()]);
  const page = await context.newPage();

  // Console errors are a UI finding in their own right — a page that renders
  // while throwing is a page that will break on the next data shape.
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

  /**
   * Navigate, and REFUSE to proceed unless the intended page actually
   * rendered.
   *
   * The first version of this file asserted only absences ("no legacy role
   * names appear"), which passed happily against the app's not-found page —
   * three green checks that meant nothing. The router treats the first path
   * segment as a company prefix, so every in-app route needs one. Anchoring
   * each visit on text that ONLY the target page renders is what makes a
   * pass evidence instead of a coincidence.
   */
  async function visit(route, name, mustContain) {
    const res = await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(1200); // let react-query paint its data
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
    const text = await page.locator("body").innerText();
    const notFound = /No company matches prefix|NOT FOUND/i.test(text);
    const anchored = mustContain ? new RegExp(mustContain, "i").test(text) : true;
    return { status: res?.status() ?? 0, text, loaded: !notFound && anchored };
  }

  // The router mounts the app under a company prefix; without it every route
  // resolves to "no company matches prefix".
  const P = `/${await companyPrefix()}`;

  // 1. Dashboard renders at all.
  const dash = await visit(`${P}/dashboard`, "01-dashboard", "dashboard|overview|agents");
  record("dashboard loads", dash.status === 200 && dash.loaded, dash.loaded ? "" : "did not render");

  // 2. Costs — Gate 0/2: never an unmeasured zero.
  const costs = await visit(`${P}/costs`, "02-costs", "cost|spend");
  record("costs page actually rendered", costs.loaded);
  const costsText = costs.text;
  const saysNotMeasured = /not measured/i.test(costsText);
  const zeroLines = costsText.split("\n").filter((l) => /\$0\.00/.test(l));
  // The first version of this check failed on ANY "$0.00" on the page, which
  // is too crude — a budget ceiling of $0.00 is not the bug. The bug Gate 0
  // named is a zero presented as a SPEND figure while the instance says the
  // data is not measured. So: require the label, and report how many zero
  // lines remain as the honest measure of Gate 2's unfinished surfaces.
  record(
    "costs labels unmeasured spend rather than showing a bare zero",
    saysNotMeasured,
    saysNotMeasured
      ? `${zeroLines.length} line(s) still render $0.00 — Gate 2 surfaces not yet gated`
      : "no 'Not measured' label at all",
  );

  // 3. The O2 error page, built tonight.
  const err = await visit(`${P}/company/settings/errors`, "03-errors", "Alerting is|No errors recorded");
  record("instance errors page renders", err.loaded, err.loaded ? "" : "did not render");
  record(
    "error page states whether ALERTING is on",
    /Alerting is (on|NOT configured)/i.test(err.text),
    (err.text.match(/Alerting is [^.\n]*/i) ?? ["absent"])[0],
  );

  // 4. Company access — the two-role model must be visible, with no legacy
  //    roles. The absence check is only meaningful once the page is proven
  //    to have rendered, which is what `loaded` guarantees.
  const access = await visit(`${P}/company/settings/access`, "04-access", "access|member|role");
  record("access page actually rendered", access.loaded);
  const legacy = ["Operator", "Viewer"].filter((r) => new RegExp(`\\b${r}\\b`).test(access.text));
  record(
    "access page shows no legacy role names",
    access.loaded && legacy.length === 0,
    legacy.join(", ") || "none",
  );

  // 5. Invites — the role choices offered must be exactly admin/member.
  const inv = await visit(`${P}/company/settings/invites`, "05-invites", "invite");
  record("invites page actually rendered", inv.loaded);
  record(
    "invite offers Member and Admin only",
    inv.loaded && /Member/.test(inv.text) && /Admin/.test(inv.text)
      && !/\bOperator\b|\bViewer\b/.test(inv.text),
  );

  // 6. Projects list renders (A5 visibility path runs here).
  const proj = await visit(`${P}/projects`, "06-projects", "project");
  record("projects page loads under the visibility filter", proj.loaded, `http ${proj.status}`);

  /**
   * Separated deliberately. Navigating six pages quickly trips the rate
   * limiter on the plugin `GET /status` poll, which surfaces as a console
   * 429. That is the limiter doing its job on a chatty poll, not the app
   * breaking — but it is also a real thing a fast-clicking user can see, so
   * it is reported as its own line rather than folded into "app errors"
   * where it would either mask a genuine fault or cry wolf about one.
   */
  const rateLimited = consoleErrors.filter((e) => /429|Rate limited/i.test(e));
  const appErrors = consoleErrors.filter((e) => !/429|Rate limited/i.test(e));
  record("no application console errors", appErrors.length === 0, appErrors.slice(0, 3).join(" | "));
  record(
    "rate limiter not tripped by ordinary navigation",
    rateLimited.length === 0,
    rateLimited.length ? `${rateLimited.length} 429(s) — plugin /status poll` : "",
  );

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("walkthrough failed to run:", err.message);
  process.exitCode = 2;
});
