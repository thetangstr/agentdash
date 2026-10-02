import { describe, expect, it } from "vitest";
import {
  isOnboardingPath,
  onboardingPathCompanyPrefix,
  resolveRouteOnboardingOptions,
  shouldRedirectCompanylessRouteToOnboarding,
} from "./onboarding-route";

describe("isOnboardingPath", () => {
  it("matches the global onboarding route", () => {
    expect(isOnboardingPath("/onboarding")).toBe(true);
  });

  it("matches a company-prefixed onboarding route", () => {
    expect(isOnboardingPath("/pap/onboarding")).toBe(true);
  });

  it("ignores non-onboarding routes", () => {
    expect(isOnboardingPath("/pap/dashboard")).toBe(false);
  });
});

describe("resolveRouteOnboardingOptions", () => {
  it("opens company creation for the global onboarding route", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/onboarding",
        companies: [],
      }),
    ).toEqual({ initialStep: 1 });
  });

  it("opens agent creation when the prefixed company exists", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding",
        companyPrefix: "pap",
        companies: [{ id: "company-1", issuePrefix: "PAP" }],
      }),
    ).toEqual({ initialStep: 2, companyId: "company-1" });
  });

  it("falls back to company creation when the prefixed company is missing", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding",
        companyPrefix: "pap",
        companies: [],
      }),
    ).toEqual({ initialStep: 1 });
  });
});

describe("resolveRouteOnboardingOptions (lane J: never a second company)", () => {
  const companies = [
    { id: "company-1", issuePrefix: "WAN" },
    { id: "company-2", issuePrefix: "NOR" },
  ];

  it("reads the prefix from the path when params have none (wizard mounts outside the route)", () => {
    expect(onboardingPathCompanyPrefix("/WAN/onboarding")).toBe("WAN");
    expect(onboardingPathCompanyPrefix("/onboarding")).toBeUndefined();
    expect(
      resolveRouteOnboardingOptions({ pathname: "/nor/onboarding", companies }),
    ).toEqual({ initialStep: 2, companyId: "company-2" });
  });

  it("opens the agent step for the selected company on the unprefixed route", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/onboarding",
        companies,
        selectedCompanyId: "company-2",
      }),
    ).toEqual({ initialStep: 2, companyId: "company-2" });
  });

  it("falls back to an existing company rather than step 1 for an unknown prefix", () => {
    expect(
      resolveRouteOnboardingOptions({ pathname: "/zzz/onboarding", companies }),
    ).toEqual({ initialStep: 2, companyId: "company-1" });
  });
});

describe("shouldRedirectCompanylessRouteToOnboarding", () => {
  it("redirects companyless entry routes into onboarding", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/",
        hasCompanies: false,
      }),
    ).toBe(true);
  });

  it("does not redirect when already on onboarding", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/onboarding",
        hasCompanies: false,
      }),
    ).toBe(false);
  });

  it("does not redirect when companies exist", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/issues",
        hasCompanies: true,
      }),
    ).toBe(false);
  });
});
