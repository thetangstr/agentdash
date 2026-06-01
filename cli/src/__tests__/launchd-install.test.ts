import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("macOS launchd installer", () => {
  it("runs the service from a built source checkout with Hermes-ready defaults", () => {
    const installScript = readFileSync(path.join(repoRoot, "docker/launchd/install.sh"), "utf8");
    const plistTemplate = readFileSync(path.join(repoRoot, "docker/launchd/ai.agentdash.agent.plist"), "utf8");

    expect(installScript).toContain("APP_DIR=");
    expect(installScript).toContain('"$PNPM_BIN" install --frozen-lockfile');
    expect(installScript).toContain('"$PNPM_BIN" build');
    expect(installScript).toContain("docker exec agentdash-pg pg_isready");
    expect(installScript).toContain("service_loaded()");
    expect(installScript).toContain("'$3 == label");
    expect(installScript).toContain("NODE_ENV=production");
    expect(installScript).toContain("AGENTDASH_DEFAULT_ADAPTER=hermes_local");
    expect(installScript).toContain("AGENTDASH_HERMES_COMMAND=");
    expect(plistTemplate).toContain("%%APP_DIR%%");
    expect(plistTemplate).toContain("--filter @paperclipai/server exec tsx src/index.ts");
  });
});
