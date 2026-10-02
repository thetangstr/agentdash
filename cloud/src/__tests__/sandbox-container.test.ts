// AgentDash: container-level proof for the spike — real uid separation and
// real nftables enforcement inside the image (R2/R3), not a mock.
//
// Gated on a live Docker daemon: when none is available the suite skips and
// the unit tests (policy checks, permission assertions) still cover the
// logic. The documented manual check for a no-Docker box is in SPIKE.md.
//
// Docker calls run with a clean DOCKER_CONFIG so a broken credential helper
// on the dev box can't hang the suite (public images pull anonymously).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX_DIR = fileURLToPath(new URL("../../sandbox", import.meta.url));
const IMAGE = "agentdash-sandbox-test";
const BASE = "node:24-bookworm-slim";

const dockerCfg = mkdtempSync(join(tmpdir(), "docker-cfg-"));
writeFileSync(join(dockerCfg, "config.json"), "{}");
const DOCKER_ENV = { ...process.env, DOCKER_CONFIG: dockerCfg };

function docker(args: string[], opts: { allowFail?: boolean; timeout?: number } = {}): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      timeout: opts.timeout ?? 30_000,
      env: DOCKER_ENV,
    });
  } catch (err) {
    if (opts.allowFail) {
      const e = err as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    throw err;
  }
}

function dockerOk(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", env: DOCKER_ENV, timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const DOCKER = dockerOk();
let cid = "";

function sh(script: string, opts: { allowFail?: boolean } = {}): string {
  return docker(["exec", cid, "sh", "-c", script], { ...opts, timeout: 30_000 });
}

describe.skipIf(!DOCKER)("sandbox container", () => {
  beforeAll(() => {
    // Pull the base image first with a bounded wait — a hung registry call
    // here is detectable and skippable, unlike a hang inside docker build.
    docker(["pull", BASE], { timeout: 180_000 });
    docker(["build", "-q", "-t", IMAGE, SANDBOX_DIR], { timeout: 600_000 });
    cid = docker(["run", "-d", "--rm", "--cap-add", "NET_ADMIN", IMAGE, "sleep", "infinity"]).trim();
    // Wait for the signer socket — entrypoint applies egress first.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const ready = sh(
        'echo \'{"op":"health"}\' | node /opt/sandbox/sockcat.mjs /run/sandbox-signer/sign.sock 2>/dev/null || true',
      );
      if (ready.includes('"ok":true')) break;
      if (Date.now() > deadline) throw new Error("sandbox never became ready");
      execSync("sleep 0.2");
    }
  }, 660_000);

  afterAll(() => {
    if (cid) {
      try {
        docker(["stop", cid]);
      } catch {
        /* already gone */
      }
    }
  });

  it("runs the per-sandbox health check clean (R9)", () => {
    const out = sh("node /opt/sandbox/sandbox-ctl.mjs --state /run/sandbox health");
    const health = JSON.parse(out.trim().split("\n").pop()!);
    expect(health.ok).toBe(true);
    expect(health.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it("the agent uid cannot read the signer key (R2)", () => {
    const out = sh(
      'su -s /bin/sh agent -c "cat /etc/sandbox-signer/signing-key.pem" 2>&1; echo "exit=$?"',
      { allowFail: true },
    );
    expect(out).toMatch(/Permission denied|can't open|No such file/);
    expect(out).toContain("exit=1");
  });

  it("the agent uid CAN reach the signer socket and get a policy refusal", () => {
    const out = sh(
      `su -s /bin/sh agent -c 'echo "{\\"op\\":\\"sign\\",\\"sessionId\\":\\"x\\",\\"artifactType\\":\\"wire_transfer\\",\\"payloadB64\\":\\"eA==\\"}" | node /opt/sandbox/sockcat.mjs /run/sandbox-signer/sign.sock'`,
    );
    expect(out).toContain('"ok":false');
    expect(out).toContain("policy_denied");
  });

  it("nftables enforces per-uid egress: agent rejected off the allow-list (R3)", () => {
    // TEST-NET-1 (192.0.2.0/24) is unroutable; a passing connect would hang,
    // our reject answers immediately — assert on the fast failure.
    const out = sh(
      `su -s /bin/sh agent -c 'timeout 5 node -e "const s=require(\\"net\\").connect(443,\\"192.0.2.9\\");s.on(\\"connect\\",()=>{console.log(\\"CONNECTED\\");process.exit(0)});s.on(\\"error\\",(e)=>{console.log(\\"ERR:\\"+e.code);process.exit(0)});setTimeout(()=>{console.log(\\"TIMEOUT\\");process.exit(0)},3000)"'`,
      { allowFail: true },
    );
    expect(out).toContain("ERR:");
    expect(out).not.toContain("CONNECTED");
    expect(out).not.toContain("TIMEOUT");
  });

  it("nftables table is loaded with a drop policy", () => {
    const rules = sh("nft list table inet sandbox_egress");
    expect(rules).toContain("policy drop");
    expect(rules).toContain("skuid");
  });
});
