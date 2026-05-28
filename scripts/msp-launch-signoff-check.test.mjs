import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "msp-launch-signoff-check.sh");

function withTempFiles(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdash-signoff-test-"));
  try {
    const paths = {};
    for (const [name, contents] of Object.entries(files)) {
      const filePath = path.join(dir, name);
      writeFileSync(filePath, contents);
      paths[name] = filePath;
    }
    return fn(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runSignoffCheck(args) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

const completeResponse = `AgentDash MSP pilot external confirmation

Chosen access path: LAN
Tailscale ACL/private-network notes: Private LAN only; no Tailscale.
Partner proof timestamp: 2026-05-28T01:02:03Z
Partner proof transcript location or redacted output: proof.txt
Proof account can see expected company: yes
Browser /assess?onboarding=1 reachable if required: not required
Browser /cos Hermes-backed reply run id or transcript: run abc123
Operator account maxiaoer confirmed: yes
GitHub token rotation confirmed: yes
Launch owner: Alice
Partner champion: Bob
MSP service manager / first operator: Charlie
Week-one issue channel: #agentdash-pilot
Week-one daily check-in time: 09:00 PT
Week-one approved data classes: Sanitized ticket summaries and non-secret workflow notes.
No public URL used unless approved: yes
`;

const partnerProof = `AgentDash MSP partner access proof
Timestamp: 2026-05-28T01:02:03Z
Mode: login proof

Summary: 11 pass, 0 warn, 0 fail
Status: Partner-device access proof passed.
`;

test("accepts a complete external confirmation response with full partner proof", () => {
  withTempFiles(
    {
      "response.txt": completeResponse,
      "proof.txt": partnerProof,
    },
    (paths) => {
      const result = runSignoffCheck([
        "--response",
        paths["response.txt"],
        "--proof-output",
        paths["proof.txt"],
      ]);

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Status: Launch external signoff check passed\./);
      assert.match(result.stdout, /Summary: \d+ pass, 0 warn, 0 fail/);
    },
  );
});

test("rejects no-go confirmation fields", () => {
  withTempFiles(
    {
      "response.txt": completeResponse.replace(
        "GitHub token rotation confirmed: yes",
        "GitHub token rotation confirmed: no",
      ),
      "proof.txt": partnerProof,
    },
    (paths) => {
      const result = runSignoffCheck([
        "--response",
        paths["response.txt"],
        "--proof-output",
        paths["proof.txt"],
      ]);

      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /GitHub token rotation confirmed must be yes/i);
      assert.match(result.stdout, /Status: NOT READY for external launch signoff\./);
    },
  );
});

test("rejects network-only proof transcripts", () => {
  withTempFiles(
    {
      "response.txt": completeResponse,
      "proof.txt": partnerProof
        .replace("Mode: login proof", "Mode: network-only precheck")
        .replace(
          "Status: Partner-device access proof passed.",
          "Status: Network precheck passed. This does not satisfy the partner-device login proof gate.",
        ),
    },
    (paths) => {
      const result = runSignoffCheck([
        "--response",
        paths["response.txt"],
        "--proof-output",
        paths["proof.txt"],
      ]);

      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Partner proof transcript must be a full login proof/i);
    },
  );
});

test("requires Tailscale ACL notes when Tailscale is the chosen path", () => {
  withTempFiles(
    {
      "response.txt": completeResponse
        .replace("Chosen access path: LAN", "Chosen access path: Tailscale")
        .replace("Tailscale ACL/private-network notes: Private LAN only; no Tailscale.", "Tailscale ACL/private-network notes:"),
      "proof.txt": partnerProof,
    },
    (paths) => {
      const result = runSignoffCheck([
        "--response",
        paths["response.txt"],
        "--proof-output",
        paths["proof.txt"],
      ]);

      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Tailscale ACL\/private-network notes is required/i);
    },
  );
});
