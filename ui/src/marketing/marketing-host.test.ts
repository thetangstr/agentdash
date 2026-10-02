import { describe, expect, it } from "vitest";
import { MARKETING_HOSTNAMES, MARKETING_HOST_SUFFIXES, isMarketingHostname } from "./marketing-host";

// AgentDash (PR #955 review): on a marketing host, `/` and the www-only pages
// never redirect, whatever health says; on any other host `/` is the app or
// its sign-in. Which hosts are marketing is therefore a product decision, and
// this pin makes adding one a conscious change: update the list here too.
describe("marketing host allowlist", () => {
  it("is exactly www and the apex", () => {
    expect([...MARKETING_HOSTNAMES]).toEqual(["www.agentdash.cloud", "agentdash.cloud"]);
  });

  it("treats exactly this project's Vercel previews as marketing", () => {
    expect([...MARKETING_HOST_SUFFIXES]).toEqual([".vercel.app"]);
  });

  it("does not treat a hosted box, a self-hosted install or dev as marketing", () => {
    for (const host of ["acme.agentdash.cloud", "app.agentdash.cloud", "agentdash.example.com", "localhost", "127.0.0.1"]) {
      expect(isMarketingHostname(host)).toBe(false);
    }
  });
});
