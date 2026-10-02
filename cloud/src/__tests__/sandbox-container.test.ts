// AgentDash: container-level proof for the spike — real uid separation and
// real nftables enforcement inside the image (R2/R3), not a mock.
//
// Opt-in: `SANDBOX_DOCKER_TEST=1` is required — the suite builds an image and
// runs a NET_ADMIN container, which is too heavy for a default test run.
// With the flag set and no Docker daemon the suite FAILS loudly (an explicit
// opt-in must not silently skip). The documented manual check for a
// no-Docker box is in SPIKE.md.
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

const ENABLED = process.env.SANDBOX_DOCKER_TEST === "1";
let cid = "";

function sh(script: string, opts: { allowFail?: boolean } = {}): string {
  return docker(["exec", cid, "sh", "-c", script], { ...opts, timeout: 30_000 });
}

describe.skipIf(!ENABLED)("sandbox container", () => {
  beforeAll(() => {
    if (!dockerOk()) throw new Error("SANDBOX_DOCKER_TEST=1 set but no Docker daemon is reachable");
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

  it("a bad spec fails the apply and keeps the old table (fail-closed)", () => {
    // Required host that cannot resolve -> resolution throws BEFORE nft runs.
    const out = sh(
      `printf '%s' '{"version":1,"table":"sandbox_egress","dnsServers":[],"identities":{"agent":{"user":"agent","allow":[{"hosts":["definitely-unresolvable.invalid.example"],"ports":[443],"proto":"tcp"}]}}}' > /tmp/bad-spec.json && /opt/sandbox/egress-apply.sh /tmp/bad-spec.json; echo "exit=$?"`,
      { allowFail: true },
    );
    expect(out).toContain("exit=1");
    // The previous ruleset is still in force — not a torn-down half-apply.
    const rules = sh("nft list table inet sandbox_egress");
    expect(rules).toContain("policy drop");
    expect(rules).toContain("skuid 1101");
    // And the agent is still blocked afterwards.
    const conn = sh(
      `su -s /bin/sh agent -c 'timeout 5 node -e "const s=require(\\"net\\").connect(443,\\"192.0.2.9\\");s.on(\\"connect\\",()=>{console.log(\\"CONNECTED\\");process.exit(0)});s.on(\\"error\\",(e)=>{console.log(\\"ERR:\\"+e.code);process.exit(0)});setTimeout(()=>{console.log(\\"TIMEOUT\\");process.exit(0)},3000)"'`,
      { allowFail: true },
    );
    expect(conn).toContain("ERR:");
    expect(conn).not.toContain("CONNECTED");
  });

  it("agent has no DNS egress; allow-listed hosts are /etc/hosts-pinned (R3)", () => {
    // dns:false identity -> pinned block written by egress-apply.
    const hosts = sh("cat /etc/hosts");
    expect(hosts).toContain("sandbox-pinned-begin");
    expect(hosts).toMatch(/sandbox-pinned-begin[\s\S]*api\.z\.ai/);
    // Agent UDP to the VPC resolver (169.254.169.253:53) is rejected. (In the
    // container, /etc/resolv.conf points at Docker's embedded resolver on
    // loopback, which the lo rule permits — on the VM the resolver is the
    // link-local address this assertion exercises.)
    const out = sh(
      `su -s /bin/sh agent -c 'timeout 5 node -e "const d=require(\\"dgram\\").createSocket(\\"udp4\\");d.on(\\"error\\",(e)=>{console.log(\\"ERR:\\"+e.code);process.exit(0)});d.connect(53,\\"169.254.169.253\\",()=>{d.send(\\"x\\")});setTimeout(()=>{console.log(\\"TIMEOUT\\");process.exit(0)},3000)"'`,
      { allowFail: true },
    );
    expect(out).toContain("ERR:");
    expect(out).not.toContain("TIMEOUT");
  });

  it("agent can write run.log in /run/sandbox but the sticky bit protects others' files", () => {
    // 3770: group-writable so the agent can create its log; sticky so it
    // cannot unlink/rename files owned by other runshare members or root.
    const write = sh(
      `su -s /bin/sh agent -c 'echo logline > /run/sandbox/run.log && cat /run/sandbox/run.log'`,
    );
    expect(write).toContain("logline");
    const rootFile = sh("echo secret > /run/sandbox/root-owned.txt && chmod 0644 /run/sandbox/root-owned.txt && ls /run/sandbox");
    expect(rootFile).toContain("root-owned.txt");
    const rm = sh(
      `su -s /bin/sh agent -c 'rm /run/sandbox/root-owned.txt' 2>&1; echo "exit=$?"`,
      { allowFail: true },
    );
    expect(rm).toMatch(/Operation not permitted|Permission denied/);
    const after = sh("cat /run/sandbox/root-owned.txt");
    expect(after).toContain("secret");
  });

  it("IMDSv2 is reachable by the signer uid only (R2)", () => {
    const rules = sh("nft list table inet sandbox_egress");
    expect(rules).toMatch(/skuid 1102[^\n]*169\.254\.169\.254/);
    expect(rules).not.toMatch(/skuid 1101[^\n]*169\.254\.169\.254/);
    // and the agent is refused on a real connect to the link-local endpoint
    const out = sh(
      `su -s /bin/sh agent -c 'timeout 5 node -e "const s=require(\\"net\\").connect(80,\\"169.254.169.254\\");s.on(\\"connect\\",()=>{console.log(\\"CONNECTED\\");process.exit(0)});s.on(\\"error\\",(e)=>{console.log(\\"ERR:\\"+e.code);process.exit(0)});setTimeout(()=>{console.log(\\"TIMEOUT\\");process.exit(0)},3000)"'`,
      { allowFail: true },
    );
    expect(out).toContain("ERR:");
    expect(out).not.toContain("CONNECTED");
    expect(out).not.toContain("TIMEOUT");
  });
});
