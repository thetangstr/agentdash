import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildDeploymentPlan,
  normalizeTargetImage,
  readEnvValue,
  runDeployment,
  setEnvValue,
} from "./agentdash-ota-update.mjs";

test("normalizes raw git SHAs into GHCR sha tags", () => {
  assert.equal(
    normalizeTargetImage({
      imageRepo: "ghcr.io/acme/agentdash",
      targetSha: "ABCDEF1234567890",
    }),
    "ghcr.io/acme/agentdash:sha-abcdef1234567890",
  );
});

test("keeps explicit target images unchanged", () => {
  assert.equal(
    normalizeTargetImage({
      imageRepo: "ghcr.io/acme/agentdash",
      targetSha: "abcdef1",
      targetImage: "registry.example.com/app:release-123",
    }),
    "registry.example.com/app:release-123",
  );
});

test("rejects non-SHA tags when composing a sha image", () => {
  assert.throws(
    () => normalizeTargetImage({ imageRepo: "ghcr.io/acme/agentdash", targetSha: "latest" }),
    /Invalid target SHA/,
  );
});

test("sets env values without dropping existing settings", () => {
  const next = setEnvValue(
    [
      "# AgentDash runtime",
      "PAPERCLIP_PUBLIC_URL=https://agentdash.example.com",
      "AGENTDASH_IMAGE=ghcr.io/acme/agentdash:sha-old",
      "",
    ].join("\n"),
    "AGENTDASH_IMAGE",
    "ghcr.io/acme/agentdash:sha-new",
  );

  assert.equal(readEnvValue(next, "PAPERCLIP_PUBLIC_URL"), "https://agentdash.example.com");
  assert.equal(readEnvValue(next, "AGENTDASH_IMAGE"), "ghcr.io/acme/agentdash:sha-new");
});

test("builds update plan from current env image", () => {
  const plan = buildDeploymentPlan(
    {
      imageRepo: "ghcr.io/acme/agentdash",
      targetSha: "1234567",
      composeFile: "docker/docker-compose.production.yml",
      envFile: "agentdash.env",
      envContent: "AGENTDASH_IMAGE=ghcr.io/acme/agentdash:sha-0000000\n",
      stateDir: ".tmp/deploy-state",
      baseUrl: "https://agentdash.example.com",
    },
    {},
  );

  assert.equal(plan.action, "update");
  assert.equal(plan.previousImage, "ghcr.io/acme/agentdash:sha-0000000");
  assert.equal(plan.targetImage, "ghcr.io/acme/agentdash:sha-1234567");
  assert.equal(plan.healthUrl, "https://agentdash.example.com/api/health");
  assert.deepEqual(plan.commands.composePull[1].slice(-2), ["pull", "server"]);
});

test("builds rollback plan from deployment state", () => {
  const plan = buildDeploymentPlan(
    {
      rollback: true,
      envContent: "AGENTDASH_IMAGE=ghcr.io/acme/agentdash:sha-current\n",
      stateDir: ".tmp/deploy-state",
      baseUrl: "http://127.0.0.1:3100",
    },
    {
      currentImage: "ghcr.io/acme/agentdash:sha-current",
      previousImage: "ghcr.io/acme/agentdash:sha-previous",
    },
  );

  assert.equal(plan.action, "rollback");
  assert.equal(plan.targetImage, "ghcr.io/acme/agentdash:sha-previous");
  assert.equal(plan.previousImage, "ghcr.io/acme/agentdash:sha-current");
});

test("dry run does not create deployment state files", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-ota-"));
  try {
    const result = await runDeployment({
      imageRepo: "ghcr.io/acme/agentdash",
      targetSha: "1234567",
      composeFile: path.join(tmp, "compose.yml"),
      envFile: path.join(tmp, "agentdash.env"),
      stateDir: path.join(tmp, "state"),
      envContent: "AGENTDASH_IMAGE=ghcr.io/acme/agentdash:sha-0000000\n",
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.plan.targetImage, "ghcr.io/acme/agentdash:sha-1234567");
    assert.throws(() => readFileSync(path.join(tmp, "state", "state.json"), "utf8"), /ENOENT/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
