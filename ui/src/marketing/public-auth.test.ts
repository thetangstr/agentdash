import { describe, expect, it } from "vitest";
import { isAuthenticatedDeployment, isPublicVisitorLoggedIn } from "./public-auth";

describe("public marketing auth inference", () => {
  it("treats missing health metadata as anonymous public traffic", () => {
    expect(
      isPublicVisitorLoggedIn({
        deploymentMode: undefined,
        hasSession: false,
      }),
    ).toBe(false);
  });

  it("keeps local trusted development as implicitly logged in", () => {
    expect(
      isPublicVisitorLoggedIn({
        deploymentMode: "local_trusted",
        hasSession: false,
      }),
    ).toBe(true);
  });

  it("uses the session only in authenticated deployments", () => {
    expect(isAuthenticatedDeployment("authenticated")).toBe(true);
    expect(
      isPublicVisitorLoggedIn({
        deploymentMode: "authenticated",
        hasSession: false,
      }),
    ).toBe(false);
    expect(
      isPublicVisitorLoggedIn({
        deploymentMode: "authenticated",
        hasSession: true,
      }),
    ).toBe(true);
  });
});

