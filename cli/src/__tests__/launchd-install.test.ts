import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("macOS launchd installer", () => {
  it("runs the service from a built source checkout with claude_api + heartbeat-off defaults", () => {
    const installScript = readFileSync(path.join(repoRoot, "docker/launchd/install.sh"), "utf8");
    const plistTemplate = readFileSync(path.join(repoRoot, "docker/launchd/ai.agentdash.agent.plist"), "utf8");

    expect(installScript).toContain("APP_DIR=");
    expect(installScript).toContain('"$PNPM_BIN" install --frozen-lockfile');
    expect(installScript).toContain('"$PNPM_BIN" build');
    expect(installScript).toContain("docker exec agentdash-pg pg_isready");
    expect(installScript).toContain("service_loaded()");
    expect(installScript).toContain("'$3 == label");
    expect(installScript).toContain("NODE_ENV=production");
    // claude_api is the customer default (degrades to stub replies with no key,
    // no crash-loop); the customer wires a real key during onboarding. Heartbeat
    // is OFF until the team is confirmed so nothing spawns before a model exists.
    expect(installScript).toContain("AGENTDASH_DEFAULT_ADAPTER=claude_api");
    expect(installScript).toContain("HEARTBEAT_SCHEDULER_ENABLED=false");
    expect(plistTemplate).toContain("%%APP_DIR%%");
    expect(plistTemplate).toContain("--filter @paperclipai/server exec tsx src/index.ts");
  });
});
