import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export const defaultCreateValues: CreateConfigValues = {
  adapterType: "claude_local",
  cwd: "",
  instructionsFilePath: "",
  promptTemplate: "",
  model: "",
  thinkingEffort: "",
  chrome: false,
  dangerouslySkipPermissions: true,
  search: false,
  fastMode: false,
  dangerouslyBypassSandbox: false,
  command: "",
  args: "",
  extraArgs: "",
  envVars: "",
  envBindings: {},
  url: "",
  bootstrapPrompt: "",
  payloadTemplateJson: "",
  workspaceStrategyType: "project_primary",
  workspaceBaseRef: "",
  workspaceBranchTemplate: "",
  worktreeParentDir: "",
  runtimeServicesJson: "",
  maxTurnsPerRun: 1000,
  heartbeatEnabled: false,
  /**
   * 30 minutes, not 5 (changed 2026-08-16 by owner decision).
   *
   * Every wake is a model call whether or not there is anything to do. At
   * the old 5-minute default one agent generates ~288 runs a day — measured
   * on uat, where the chief-of-staff hit 224 by mid-evening — and six agents
   * on that cadence would be ~1,700 runs a day of mostly-nothing. Thirty
   * minutes is ~48 a day per agent: still responsive for work that arrives
   * while nobody is watching, at a sixth of the spend. Anything needing
   * faster reaction should be wake-on-demand, which is already the default
   * (`wakeOnDemand: true`) and fires on assignment rather than on a clock.
   */
  intervalSec: 1800,
};
