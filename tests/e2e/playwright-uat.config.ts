import { defineConfig } from "@playwright/test";

/**
 * UAT walkthrough config — drives a browser against a REAL running instance.
 *
 * Deliberately unlike `playwright.config.ts`, which boots a throwaway
 * `local_trusted` server. That mode is right for regression tests and wrong
 * here: `local_trusted` softens authentication, so a walkthrough run against it
 * would skip the sign-up it is supposed to prove.
 *
 * The base URL must be the LAN or Tailscale address, never loopback. Better
 * Auth derives its trusted origins from `PAPERCLIP_AUTH_PUBLIC_BASE_URL` plus
 * `PAPERCLIP_ALLOWED_HOSTNAMES`, and `127.0.0.1` is in neither — a run against
 * loopback fails at sign-in with `403 INVALID_ORIGIN`, which looks like a
 * broken product rather than a wrong address.
 *
 * Headed by default, and slowed down, because the point of this suite is that
 * a person can watch it happen.
 */
const BASE_URL = process.env.UAT_BASE_URL?.trim() || "http://192.168.86.57:3103";
const HEADLESS = process.env.UAT_HEADLESS === "true";
const SLOW_MO = Number(process.env.UAT_SLOW_MO ?? (HEADLESS ? 0 : 250));

export default defineConfig({
  testDir: ".",
  testMatch: "uat-*.spec.ts",
  // One worker: the walkthrough is a narrative, and a second browser racing it
  // through the same workspace would make every assertion ambiguous.
  workers: 1,
  retries: 0,
  // Generous: real inference runs behind several of these steps, and MiniMax
  // takes 10-50s per turn.
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    // Without these, a locator that never matches makes an action wait for the
    // whole 15-minute test timeout with no output — which is exactly what
    // happened once: a selector that stopped matching looked like a hung
    // machine rather than a failed assertion. Fail fast and say why.
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    headless: HEADLESS,
    launchOptions: { slowMo: SLOW_MO },
    screenshot: "on",
    video: "retain-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  outputDir: "test-results/uat",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
