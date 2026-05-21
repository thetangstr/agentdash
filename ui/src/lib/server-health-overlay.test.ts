import { describe, expect, it } from "vitest";
import { shouldShowServerUnreachableOverlay } from "./server-health-overlay";

describe("server health overlay route gate", () => {
  it.each(["/", "/consulting", "/about", "/cos-pilot-deck", "/assess"])(
    "does not show the server overlay on public static route %s",
    (pathname) => {
      expect(shouldShowServerUnreachableOverlay(pathname)).toBe(false);
    },
  );

  it.each(["/auth", "/companies", "/PAP/dashboard", "/instance/settings/general"])(
    "keeps the server overlay active on backend-backed route %s",
    (pathname) => {
      expect(shouldShowServerUnreachableOverlay(pathname)).toBe(true);
    },
  );
});
