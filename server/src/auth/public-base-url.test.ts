import { describe, expect, it } from "vitest";
import { rewritePublicBaseUrlPort } from "./public-base-url.js";

describe("rewritePublicBaseUrlPort", () => {
  it("follows the process when its own port was taken", () => {
    expect(
      rewritePublicBaseUrlPort("http://localhost:3000", { requestedPort: 3000, listenPort: 3001 }),
    ).toBe("http://localhost:3001/");
  });

  it("leaves a reverse-proxied public URL alone", () => {
    // The MKThink Mini: Caddy serves :3112 and proxies to the app on :3102.
    // Rewriting this to :3102 is what refused every browser sign-in with
    // INVALID_ORIGIN, because the trusted origins stopped matching the port
    // people actually arrive on.
    expect(
      rewritePublicBaseUrlPort("https://mkthinks-mac-mini.tail112187.ts.net:3112", {
        requestedPort: 3102,
        listenPort: 3102,
      }),
    ).toBe("https://mkthinks-mac-mini.tail112187.ts.net:3112");
  });

  it("leaves the proxied URL alone even when the app's own port moved", () => {
    expect(
      rewritePublicBaseUrlPort("https://mkthinks-mac-mini.tail112187.ts.net:3112", {
        requestedPort: 3102,
        listenPort: 3103,
      }),
    ).toBe("https://mkthinks-mac-mini.tail112187.ts.net:3112");
  });

  it("leaves a portless URL alone", () => {
    expect(
      rewritePublicBaseUrlPort("https://board.example.com", { requestedPort: 3102, listenPort: 3103 }),
    ).toBe("https://board.example.com");
  });

  it("passes through something that is not a URL", () => {
    expect(
      rewritePublicBaseUrlPort("not a url", { requestedPort: 3102, listenPort: 3103 }),
    ).toBe("not a url");
  });

  it("returns undefined when nothing is configured", () => {
    expect(
      rewritePublicBaseUrlPort(undefined, { requestedPort: 3102, listenPort: 3103 }),
    ).toBeUndefined();
  });
});
