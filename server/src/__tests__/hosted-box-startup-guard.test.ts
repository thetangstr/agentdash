import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, createDbMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  createDbMock: vi.fn(() => {
    throw new Error("the database must not be opened when the hosted-box guard refuses");
  }),
}));

vi.mock("../config.js", () => ({ loadConfig: loadConfigMock }));
// startServer never reaches createApp when the guard refuses; mocking it keeps
// this test from needing the workspace packages built.
vi.mock("../app.js", () => ({ createApp: vi.fn() }));
vi.mock("@paperclipai/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/db")>()),
  createDb: createDbMock,
}));

import { assertHostedBoxConfig, hostedBoxConfigErrors } from "../hosted-box-guard.js";
import { deploymentKind, isHostedBox } from "../services/license.js";
import { startServer } from "../index.ts";

// A hosted box that satisfies every precondition. Each test below removes one.
function safeHostedEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    AGENTDASH_DEPLOYMENT_KIND: "hosted",
    PAPERCLIP_PUBLIC_URL: "https://acme.agentdash.cloud",
    AGENTDASH_HERMES_MANAGED_PROFILES: "true",
    AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE: "true",
    AGENTDASH_INVITE_CODES: "acme-7f3a9c21e4b8",
    ...overrides,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env as NodeJS.ProcessEnv;
}

const authenticated = {
  deploymentMode: "authenticated" as const,
  authDisableSignUp: false,
  authPublicBaseUrl: "https://acme.agentdash.cloud" as string | undefined,
  authBaseUrlMode: "explicit" as "explicit" | "auto",
};
const localTrusted = { ...authenticated, deploymentMode: "local_trusted" as const };

describe("hosted-box boot guard (#726)", () => {
  describe("the hosted flag", () => {
    it("is off unless AGENTDASH_DEPLOYMENT_KIND=hosted", () => {
      expect(isHostedBox({})).toBe(false);
      expect(isHostedBox({ AGENTDASH_DEPLOYMENT_KIND: "cloud" })).toBe(false);
      expect(isHostedBox({ AGENTDASH_DEPLOYMENT_KIND: "on_prem" })).toBe(false);
      expect(isHostedBox({ AGENTDASH_DEPLOYMENT_KIND: " hosted " })).toBe(true);
    });

    it("keeps the SKU as cloud, so markup and license behaviour do not change", () => {
      const original = process.env.AGENTDASH_DEPLOYMENT_KIND;
      process.env.AGENTDASH_DEPLOYMENT_KIND = "hosted";
      try {
        expect(deploymentKind()).toBe("cloud");
      } finally {
        if (original === undefined) delete process.env.AGENTDASH_DEPLOYMENT_KIND;
        else process.env.AGENTDASH_DEPLOYMENT_KIND = original;
      }
    });
  });

  describe("without the hosted flag", () => {
    it("accepts local_trusted with nothing else set, as local dev does today", () => {
      expect(hostedBoxConfigErrors(localTrusted, {})).toEqual([]);
      expect(() =>
        assertHostedBoxConfig(localTrusted, {})).not.toThrow();
    });

    it("accepts an on-prem box with open sign-up and no public URL", () => {
      expect(
        hostedBoxConfigErrors(authenticated, { AGENTDASH_DEPLOYMENT_KIND: "on_prem" }),
      ).toEqual([]);
    });
  });

  describe("with the hosted flag", () => {
    it("passes when every precondition holds", () => {
      expect(hostedBoxConfigErrors(authenticated, safeHostedEnv())).toEqual([]);
      expect(() => assertHostedBoxConfig(authenticated, safeHostedEnv())).not.toThrow();
    });

    it("passes with sign-up disabled instead of invite codes", () => {
      const env = safeHostedEnv({
        AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE: undefined,
        AGENTDASH_INVITE_CODES: undefined,
      });
      expect(hostedBoxConfigErrors({ ...authenticated, authDisableSignUp: true }, env)).toEqual([]);
    });

    it("refuses local_trusted and names it", () => {
      const errors = hostedBoxConfigErrors(
        localTrusted,
        safeHostedEnv(),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("PAPERCLIP_DEPLOYMENT_MODE");
      expect(errors[0]).toContain("local_trusted");
    });

    it("refuses a missing PAPERCLIP_PUBLIC_URL", () => {
      const errors = hostedBoxConfigErrors(authenticated, safeHostedEnv({ PAPERCLIP_PUBLIC_URL: undefined }));
      expect(errors).toEqual([expect.stringContaining("PAPERCLIP_PUBLIC_URL is not set")]);
    });

    it("refuses a plain-http or malformed PAPERCLIP_PUBLIC_URL", () => {
      for (const url of ["http://acme.agentdash.cloud", "acme.agentdash.cloud"]) {
        const errors = hostedBoxConfigErrors(authenticated, safeHostedEnv({ PAPERCLIP_PUBLIC_URL: url }));
        expect(errors).toEqual([expect.stringContaining("PAPERCLIP_PUBLIC_URL must be an https:// URL")]);
      }
    });

    it("refuses when managed Hermes profiles are off", () => {
      for (const value of [undefined, "false", "1"]) {
        const errors = hostedBoxConfigErrors(
          authenticated,
          safeHostedEnv({ AGENTDASH_HERMES_MANAGED_PROFILES: value }),
        );
        expect(errors).toEqual([expect.stringContaining("AGENTDASH_HERMES_MANAGED_PROFILES")]);
      }
    });

    it("refuses open sign-up", () => {
      const errors = hostedBoxConfigErrors(
        authenticated,
        safeHostedEnv({ AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE: undefined, AGENTDASH_INVITE_CODES: undefined }),
      );
      expect(errors).toEqual([expect.stringContaining("Sign-up is open to anyone")]);
    });

    it("refuses an invite gate with no codes configured", () => {
      const errors = hostedBoxConfigErrors(authenticated, safeHostedEnv({ AGENTDASH_INVITE_CODES: " , " }));
      expect(errors).toEqual([expect.stringContaining("AGENTDASH_INVITE_CODES is empty")]);
    });

    it("refuses when the auth base URL the app uses is missing, implicit or http", () => {
      expect(hostedBoxConfigErrors({ ...authenticated, authPublicBaseUrl: undefined }, safeHostedEnv()))
        .toEqual([expect.stringContaining("The auth base URL is not explicit")]);
      expect(hostedBoxConfigErrors({ ...authenticated, authBaseUrlMode: "auto" }, safeHostedEnv()))
        .toEqual([expect.stringContaining("The auth base URL is not explicit")]);
      expect(
        hostedBoxConfigErrors({ ...authenticated, authPublicBaseUrl: "http://acme.agentdash.cloud" }, safeHostedEnv()),
      ).toEqual([expect.stringContaining("PAPERCLIP_AUTH_PUBLIC_BASE_URL / BETTER_AUTH_URL) must be an https:// URL")]);
    });

    it("refuses placeholder and short invite codes", () => {
      for (const codes of ["CHANGEME_one_or_more_comma_separated_codes", "changeme-real-looking-code", "short-code", "acme-7f3a9c21e4b8,abc"]) {
        const errors = hostedBoxConfigErrors(authenticated, safeHostedEnv({ AGENTDASH_INVITE_CODES: codes }));
        expect(errors, codes).toEqual([expect.stringContaining("template placeholders (CHANGEME...) or shorter than 12")]);
      }
      const mk = hostedBoxConfigErrors(authenticated, safeHostedEnv({ AGENTDASH_MK_INVITE_CODES: "mk1" }));
      expect(mk).toEqual([expect.stringContaining("template placeholders")]);
    });

    it("fails the Railway template as shipped, until real values are filled in", async () => {
      const { readFileSync } = await import("node:fs");
      const text = readFileSync(new URL("../../../.env.railway.example", import.meta.url), "utf8");
      const env: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match) env[match[1]!] = match[2]!.replace(/\s+#.*$/, "");
      }
      expect(env.AGENTDASH_DEPLOYMENT_KIND).toBe("hosted");
      const errors = hostedBoxConfigErrors(
        { ...authenticated, authPublicBaseUrl: env.PAPERCLIP_AUTH_PUBLIC_BASE_URL },
        env as NodeJS.ProcessEnv,
      );
      expect(errors).toEqual([expect.stringContaining("template placeholders")]);
    });

    it("sets AGENTDASH_SELF_SERVE_BOOTSTRAP in the Railway template exactly as provision-box.sh does", async () => {
      const { readFileSync } = await import("node:fs");
      const template = readFileSync(new URL("../../../.env.railway.example", import.meta.url), "utf8");
      const provision = readFileSync(new URL("../../../scripts/hosted/provision-box.sh", import.meta.url), "utf8");
      const templateValue = /^AGENTDASH_SELF_SERVE_BOOTSTRAP=(\S+)/m.exec(template)?.[1];
      const provisionValue = /^\s*AGENTDASH_SELF_SERVE_BOOTSTRAP:\s*"([^"]+)"/m.exec(provision)?.[1];
      expect(provisionValue).toBe("true");
      expect(templateValue).toBe(provisionValue);
    });

    it("refuses MCP invite validation off while self-serve bootstrap is on", () => {
      const errors = hostedBoxConfigErrors(
        authenticated,
        safeHostedEnv({ AGENTDASH_SELF_SERVE_BOOTSTRAP: "true", AGENTDASH_INVITE_VALIDATION: " OFF " }),
      );
      expect(errors).toEqual([expect.stringContaining("AGENTDASH_INVITE_VALIDATION=off")]);
      expect(
        hostedBoxConfigErrors(authenticated, safeHostedEnv({ AGENTDASH_INVITE_VALIDATION: "off" })),
      ).toEqual([]);
      expect(
        hostedBoxConfigErrors(authenticated, safeHostedEnv({ AGENTDASH_SELF_SERVE_BOOTSTRAP: "true" })),
      ).toEqual([]);
    });

    it("refuses a multi-tenant Microsoft app unless explicitly allowed", () => {
      const microsoft = { MICROSOFT_CLIENT_ID: "client", MICROSOFT_CLIENT_SECRET: "secret" };
      for (const tenant of [undefined, "common", "organizations", "Consumers"]) {
        const errors = hostedBoxConfigErrors(
          authenticated,
          safeHostedEnv({ ...microsoft, MICROSOFT_TENANT_ID: tenant }),
        );
        expect(errors, String(tenant)).toEqual([expect.stringContaining("admits accounts from any Microsoft tenant")]);
      }
      expect(
        hostedBoxConfigErrors(authenticated, safeHostedEnv({ ...microsoft, MICROSOFT_TENANT_ID: "0b6c1f7e-acme-tenant" })),
      ).toEqual([]);
      expect(
        hostedBoxConfigErrors(
          authenticated,
          safeHostedEnv({ ...microsoft, AGENTDASH_HOSTED_ALLOW_MULTI_TENANT_MICROSOFT: "true" }),
        ),
      ).toEqual([]);
    });

    it("reads the invite gate flag the same way the app does", () => {
      const errors = hostedBoxConfigErrors(
        authenticated,
        safeHostedEnv({ AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE: " TRUE " }),
      );
      expect(errors).toEqual([]);
    });

    it("names every failed precondition in one error", () => {
      expect(() =>
        assertHostedBoxConfig(
          localTrusted,
          { AGENTDASH_DEPLOYMENT_KIND: "hosted" },
        )).toThrowError(
        /Refusing to start: AGENTDASH_DEPLOYMENT_KIND=hosted[\s\S]*local_trusted[\s\S]*PAPERCLIP_PUBLIC_URL[\s\S]*AGENTDASH_HERMES_MANAGED_PROFILES[\s\S]*Sign-up is open/,
      );
    });
  });

  describe("startServer", () => {
    const KEYS = [
      "AGENTDASH_DEPLOYMENT_KIND",
      "PAPERCLIP_PUBLIC_URL",
      "AGENTDASH_HERMES_MANAGED_PROFILES",
      "AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE",
      "AGENTDASH_INVITE_CODES",
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of KEYS) saved[key] = process.env[key];
      createDbMock.mockClear();
    });

    afterEach(() => {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it("exits at startup, before opening the database, when a hosted box is configured local_trusted", async () => {
      Object.assign(process.env, safeHostedEnv());
      loadConfigMock.mockReturnValue({ ...localTrusted, deploymentExposure: "private" });

      await expect(startServer()).rejects.toThrow(
        /Refusing to start: AGENTDASH_DEPLOYMENT_KIND=hosted[\s\S]*"local_trusted"/,
      );
      expect(createDbMock).not.toHaveBeenCalled();
    });
  });

  // AgentDash (#725): the anonymous trial creates a company; a hosted box holds one.
  describe("anonymous trial", () => {
    it("refuses AGENTDASH_TRIAL_ANONYMOUS=true on a hosted box", () => {
      const errors = hostedBoxConfigErrors(authenticated, safeHostedEnv({ AGENTDASH_TRIAL_ANONYMOUS: "true" }));
      expect(errors.some((line) => line.includes("AGENTDASH_TRIAL_ANONYMOUS"))).toBe(true);
    });

    it("accepts it false or unset (the routes are off on hosted either way)", () => {
      expect(hostedBoxConfigErrors(authenticated, safeHostedEnv({ AGENTDASH_TRIAL_ANONYMOUS: "false" }))).toEqual([]);
      expect(hostedBoxConfigErrors(authenticated, safeHostedEnv())).toEqual([]);
    });

    it("ignores it off hosted boxes", () => {
      expect(hostedBoxConfigErrors(authenticated, { AGENTDASH_TRIAL_ANONYMOUS: "true" })).toEqual([]);
    });
  });
});
