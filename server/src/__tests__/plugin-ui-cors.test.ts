import { describe, it, expect } from "vitest";
import {
  resolvePluginUiAllowedOrigin,
  parsePluginUiAllowedOrigins,
} from "../routes/plugin-ui-static.js";

describe("resolvePluginUiAllowedOrigin", () => {
  describe("local_trusted (dev)", () => {
    it("returns a permissive wildcard regardless of inputs", () => {
      expect(
        resolvePluginUiAllowedOrigin({
          deploymentMode: "local_trusted",
          requestOrigin: "http://localhost:5173",
          allowedOrigins: [],
          publicBaseUrl: undefined,
        }),
      ).toBe("*");
    });

    it("stays permissive even when an allowlist is configured", () => {
      expect(
        resolvePluginUiAllowedOrigin({
          deploymentMode: "local_trusted",
          requestOrigin: "https://evil.example.com",
          allowedOrigins: ["https://good.example.com"],
          publicBaseUrl: "https://app.example.com",
        }),
      ).toBe("*");
    });
  });

  describe("authenticated", () => {
    it("never returns a wildcard", () => {
      const result = resolvePluginUiAllowedOrigin({
        deploymentMode: "authenticated",
        requestOrigin: "https://app.example.com",
        allowedOrigins: [],
        publicBaseUrl: "https://app.example.com",
      });
      expect(result).not.toBe("*");
    });

    it("defaults to the same-origin derived from publicBaseUrl", () => {
      expect(
        resolvePluginUiAllowedOrigin({
          deploymentMode: "authenticated",
          requestOrigin: undefined,
          allowedOrigins: [],
          publicBaseUrl: "https://app.example.com",
        }),
      ).toBe("https://app.example.com");
    });

    it("normalizes publicBaseUrl (path/trailing slash) to an origin", () => {
      expect(
        resolvePluginUiAllowedOrigin({
          deploymentMode: "authenticated",
          requestOrigin: undefined,
          allowedOrigins: [],
          publicBaseUrl: "https://app.example.com/dashboard/",
        }),
      ).toBe("https://app.example.com");
    });

    it("echoes a request Origin that is in the allowlist", () => {
      expect(
        resolvePluginUiAllowedOrigin({
          deploymentMode: "authenticated",
          requestOrigin: "https://plugins.example.com",
          allowedOrigins: ["https://plugins.example.com"],
          publicBaseUrl: "https://app.example.com",
        }),
      ).toBe("https://plugins.example.com");
    });

    it("does NOT reflect an arbitrary Origin not in the allowlist", () => {
      const result = resolvePluginUiAllowedOrigin({
        deploymentMode: "authenticated",
        requestOrigin: "https://evil.example.com",
        allowedOrigins: ["https://plugins.example.com"],
        publicBaseUrl: "https://app.example.com",
      });
      expect(result).not.toBe("https://evil.example.com");
      // Falls back to the instance's own origin so first-party loads still work.
      expect(result).toBe("https://app.example.com");
    });

    it("returns null (no CORS header) when no allowlist and no public URL", () => {
      expect(
        resolvePluginUiAllowedOrigin({
          deploymentMode: "authenticated",
          requestOrigin: "https://evil.example.com",
          allowedOrigins: [],
          publicBaseUrl: undefined,
        }),
      ).toBeNull();
    });

    it("honors the allowlist when only it is configured (no public URL)", () => {
      expect(
        resolvePluginUiAllowedOrigin({
          deploymentMode: "authenticated",
          requestOrigin: "https://plugins.example.com",
          allowedOrigins: ["https://plugins.example.com"],
          publicBaseUrl: undefined,
        }),
      ).toBe("https://plugins.example.com");
    });
  });
});

describe("parsePluginUiAllowedOrigins", () => {
  it("returns an empty list for undefined/empty input", () => {
    expect(parsePluginUiAllowedOrigins(undefined)).toEqual([]);
    expect(parsePluginUiAllowedOrigins("")).toEqual([]);
  });

  it("splits, trims, and drops empty entries", () => {
    expect(
      parsePluginUiAllowedOrigins(
        " https://a.example.com , https://b.example.com ,, ",
      ),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });
});
