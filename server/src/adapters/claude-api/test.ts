import type { AdapterEnvironmentTestResult, AdapterEnvironmentTestContext } from "../types.js";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const { config } = ctx;
  const apiKey = (typeof config.apiKey === "string" && config.apiKey.trim()) || process.env.ANTHROPIC_API_KEY || "";

  if (!apiKey) {
    return {
      adapterType: "claude_api",
      status: "fail",
      checks: [
        {
          code: "ANTHROPIC_API_KEY_MISSING",
          level: "error",
          message: "ANTHROPIC_API_KEY is not set",
          hint: "Set ANTHROPIC_API_KEY in your environment or configure apiKey in the adapter config.",
        },
      ],
      testedAt: new Date().toISOString(),
    };
  }

  return {
    adapterType: "claude_api",
    status: "pass",
    checks: [
      {
        code: "ANTHROPIC_API_KEY_PRESENT",
        level: "info",
        message: "ANTHROPIC_API_KEY is configured",
      },
    ],
    testedAt: new Date().toISOString(),
  };
}
