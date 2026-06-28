import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  buildSocialProviders,
  getConfiguredSocialProviders,
} from "../auth/social-providers.js";
import { authRoutes } from "../routes/auth.js";

describe("getConfiguredSocialProviders", () => {
  it("reports both providers off when no credentials are present", () => {
    expect(getConfiguredSocialProviders({})).toEqual({
      google: false,
      microsoft: false,
    });
  });

  it("requires BOTH id and secret to enable a provider", () => {
    expect(
      getConfiguredSocialProviders({ GOOGLE_CLIENT_ID: "id-only" }),
    ).toEqual({ google: false, microsoft: false });

    expect(
      getConfiguredSocialProviders({ MICROSOFT_CLIENT_SECRET: "secret-only" }),
    ).toEqual({ google: false, microsoft: false });
  });

  it("treats whitespace-only credentials as absent", () => {
    expect(
      getConfiguredSocialProviders({
        GOOGLE_CLIENT_ID: "   ",
        GOOGLE_CLIENT_SECRET: "secret",
      }),
    ).toEqual({ google: false, microsoft: false });
  });

  it("enables each provider independently when fully configured", () => {
    expect(
      getConfiguredSocialProviders({
        GOOGLE_CLIENT_ID: "gid",
        GOOGLE_CLIENT_SECRET: "gsecret",
      }),
    ).toEqual({ google: true, microsoft: false });

    expect(
      getConfiguredSocialProviders({
        MICROSOFT_CLIENT_ID: "mid",
        MICROSOFT_CLIENT_SECRET: "msecret",
      }),
    ).toEqual({ google: false, microsoft: true });
  });
});

describe("buildSocialProviders", () => {
  it("omits providers without credentials (no empty-credential entries)", () => {
    expect(buildSocialProviders({})).toEqual({});
  });

  it("defaults the Microsoft tenant to 'common' when unset", () => {
    const providers = buildSocialProviders({
      MICROSOFT_CLIENT_ID: "mid",
      MICROSOFT_CLIENT_SECRET: "msecret",
    });
    expect(providers.microsoft).toMatchObject({
      clientId: "mid",
      clientSecret: "msecret",
      tenantId: "common",
    });
  });

  it("honors an explicit Microsoft tenant id", () => {
    const providers = buildSocialProviders({
      MICROSOFT_CLIENT_ID: "mid",
      MICROSOFT_CLIENT_SECRET: "msecret",
      MICROSOFT_TENANT_ID: "my-tenant",
    });
    expect((providers.microsoft as { tenantId: string }).tenantId).toBe("my-tenant");
  });
});

describe("GET /api/auth/social-providers", () => {
  function createApp() {
    const app = express();
    app.use("/api/auth", authRoutes({} as never));
    return app;
  }

  it("returns booleans only and never leaks credentials", async () => {
    const prev = {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
      MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
    };
    process.env.GOOGLE_CLIENT_ID = "gid";
    process.env.GOOGLE_CLIENT_SECRET = "gsecret";
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;

    try {
      const res = await request(createApp()).get("/api/auth/social-providers");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ google: true, microsoft: false });
      expect(JSON.stringify(res.body)).not.toContain("gsecret");
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
