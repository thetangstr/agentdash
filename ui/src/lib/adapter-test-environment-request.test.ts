import { describe, expect, it } from "vitest";
import { buildTestEnvironmentRequest } from "./adapter-test-environment-request";

describe("buildTestEnvironmentRequest", () => {
  it("names the agent in edit mode so the server can compare against its stored config", () => {
    const adapterConfig = { hermesCommand: "/opt/custom/hermes", extraArgs: ["-p", "agentdash"] };
    expect(
      buildTestEnvironmentRequest({ isCreate: false, agentId: "agent-1", adapterConfig, environmentId: "env-1" }),
    ).toEqual({ adapterConfig, environmentId: "env-1", agentId: "agent-1" });
  });

  it("sends no agent id in create mode", () => {
    expect(
      buildTestEnvironmentRequest({ isCreate: true, agentId: "ignored", adapterConfig: {}, environmentId: "" }),
    ).toEqual({ adapterConfig: {}, environmentId: null });
  });
});
