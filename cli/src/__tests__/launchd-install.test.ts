import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const installScriptPath = path.join(repoRoot, "docker/launchd/install.sh");
const plistTemplatePath = path.join(repoRoot, "docker/launchd/ai.agentdash.agent.plist");

describe("launchd installer", () => {
  it("runs AgentDash through a generated executable wrapper that exports env vars", () => {
    const installScript = fs.readFileSync(installScriptPath, "utf8");
    const plistTemplate = fs.readFileSync(plistTemplatePath, "utf8");

    expect(installScript).toContain("LAUNCH_WRAPPER=");
    expect(installScript).toContain("write_launch_wrapper()");
    expect(installScript).toContain("set -a");
    expect(installScript).toContain('exec "${node_bin}"');
    expect(installScript).toContain("validate_launch_wrapper");
    expect(plistTemplate).toContain("%%LAUNCH_WRAPPER%%");
    expect(plistTemplate).not.toContain(". %%ENV_FILE%%");
  });

  it("generates local auth secrets instead of shipping a machine-specific default", () => {
    const installScript = fs.readFileSync(installScriptPath, "utf8");

    expect(installScript).toContain("generate_secret()");
    expect(installScript).toContain("better_auth_secret=\"$(generate_secret)\"");
    expect(installScript).toContain("agent_jwt_secret=\"$(generate_secret)\"");
    expect(installScript).toContain("replace_or_append_env_var \"BETTER_AUTH_SECRET\" \"$(generate_secret)\"");
    expect(installScript).toContain("replace_or_append_env_var \"PAPERCLIP_AGENT_JWT_SECRET\" \"$(generate_secret)\"");
    expect(installScript).not.toContain("PAPERCLIP_TAILNET_BIND_HOST=100.");
  });
});
