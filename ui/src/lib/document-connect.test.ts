// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  authNextPath,
  clearPendingConnect,
  documentRedirectUri,
  isDocumentCallbackPath,
  readCallbackParams,
  readPendingConnect,
  rememberPendingConnect,
  safeReturnTo,
} from "./document-connect";

describe("document-connect", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("builds the callback redirect URI the server pins", () => {
    expect(documentRedirectUri("microsoft", "https://agentdash.example.test")).toBe(
      "https://agentdash.example.test/connect/microsoft/callback",
    );
    expect(documentRedirectUri("microsoft", "https://agentdash.example.test/")).toBe(
      "https://agentdash.example.test/connect/microsoft/callback",
    );
  });

  it("keeps a callback's one-time code out of the sign-in redirect", () => {
    expect(authNextPath("/connect/microsoft/callback", "?code=secret&state=s")).toBe("/connect/microsoft/callback");
    expect(authNextPath("/ACME/issues", "?q=x")).toBe("/ACME/issues?q=x");
    expect(isDocumentCallbackPath("/connect/microsoft/callback")).toBe(true);
    expect(isDocumentCallbackPath("/connect-assistant")).toBe(false);
  });

  it("returns only to same-app paths, never another origin or the callback", () => {
    expect(safeReturnTo("/ACME/my-agent")).toBe("/ACME/my-agent");
    expect(safeReturnTo("/ACME/my-agent?code=x#y")).toBe("/ACME/my-agent");
    expect(safeReturnTo("//evil.example/x")).toBe("/my-agent");
    expect(safeReturnTo("https://evil.example/x")).toBe("/my-agent");
    expect(safeReturnTo("/\\evil.example")).toBe("/my-agent");
    expect(safeReturnTo("/connect/microsoft/callback")).toBe("/my-agent");
    expect(safeReturnTo(undefined)).toBe("/my-agent");
  });

  it("remembers a sign-in for its provider only, and forgets a stale one", () => {
    rememberPendingConnect(
      { provider: "microsoft", companyId: "company-1", redirectUri: "https://x/connect/microsoft/callback", returnTo: "/ACME/my-agent" },
      1_000,
    );
    expect(readPendingConnect("microsoft", 2_000)).toMatchObject({ companyId: "company-1", returnTo: "/ACME/my-agent" });
    expect(readPendingConnect("microsoft", 1_000 + 2 * 60 * 60_000)).toBeNull();
    clearPendingConnect();
    expect(readPendingConnect("microsoft", 2_000)).toBeNull();
    window.sessionStorage.setItem("agentdash.documentConnect.pending", "{not json");
    expect(readPendingConnect("microsoft")).toBeNull();
  });

  it("reads Microsoft's callback parameters", () => {
    expect(readCallbackParams("?code=c&state=s&session_state=z")).toEqual({
      code: "c",
      state: "s",
      error: null,
      errorDescription: null,
    });
    expect(readCallbackParams("?error=access_denied&error_description=no&state=s")).toEqual({
      code: null,
      state: "s",
      error: "access_denied",
      errorDescription: "no",
    });
  });
});
