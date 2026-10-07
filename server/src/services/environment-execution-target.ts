import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import {
  adapterExecutionTargetToRemoteSpec,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { parseObject } from "../adapters/utils.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import {
  assertHermesSshLaunchReady,
  evaluateHermesSshEnvironment,
  hermesSshEnabled,
} from "./hermes-ssh-policy.js";

export const DEFAULT_SANDBOX_REMOTE_CWD = "/tmp";

export async function resolveEnvironmentExecutionTarget(input: {
  db: Db;
  companyId: string;
  adapterType: string;
  environment: {
    id?: string;
    driver: string;
    config: Record<string, unknown> | null;
  };
  leaseId?: string | null;
  leaseMetadata: Record<string, unknown> | null;
  lease?: EnvironmentLease | null;
  environmentRuntime?: EnvironmentRuntimeService | null;
}): Promise<AdapterExecutionTarget | null> {
  if (input.environment.driver === "local") {
    return {
      kind: "local",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
    };
  }

  if (input.environment.driver === "sandbox") {
    if (
      input.adapterType !== "acpx_local" &&
      input.adapterType !== "codex_local" &&
      input.adapterType !== "claude_local" &&
      input.adapterType !== "gemini_local" &&
      input.adapterType !== "opencode_local" &&
      input.adapterType !== "pi_local" &&
      input.adapterType !== "cursor"
    ) {
      return null;
    }

    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      driver: input.environment.driver as "sandbox",
      config: parseObject(input.environment.config),
    });
    if (parsed.driver !== "sandbox") {
      return null;
    }

    const remoteCwd =
      typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
        ? input.leaseMetadata.remoteCwd.trim()
        : DEFAULT_SANDBOX_REMOTE_CWD;
    const timeoutMs = "timeoutMs" in parsed.config ? parsed.config.timeoutMs : null;
    const paperclipApiUrl =
      typeof input.leaseMetadata?.paperclipApiUrl === "string" && input.leaseMetadata.paperclipApiUrl.trim().length > 0
        ? input.leaseMetadata.paperclipApiUrl.trim()
        : null;

    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: parsed.config.provider,
      remoteCwd,
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      paperclipApiUrl,
      paperclipTransport: paperclipApiUrl ? "direct" : "bridge",
      timeoutMs,
      runner: input.environmentRuntime && input.lease
        ? {
            execute: async (commandInput) => {
              const startedAt = new Date().toISOString();
              const result = await input.environmentRuntime!.execute({
                environment: input.environment as Environment,
                lease: input.lease!,
                command: commandInput.command,
                args: commandInput.args,
                cwd: commandInput.cwd ?? remoteCwd,
                env: commandInput.env,
                stdin: commandInput.stdin,
                timeoutMs: commandInput.timeoutMs,
              });
              if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
              if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
              return {
                exitCode: result.exitCode,
                signal: result.signal ?? null,
                timedOut: result.timedOut,
                stdout: result.stdout,
                stderr: result.stderr,
                pid: null,
                startedAt,
              };
            },
          }
        : undefined,
    };
  }

  // AgentDash: hermes_local over SSH, behind AGENTDASH_HERMES_SSH_ENABLED and
  // the allowlist. With the flag off this is the same null as before.
  const hermesOverSsh =
    input.adapterType === "hermes_local" &&
    input.environment.driver === "ssh" &&
    hermesSshEnabled();

  if (
    (
      input.adapterType !== "codex_local" &&
      input.adapterType !== "acpx_local" &&
      input.adapterType !== "claude_local" &&
      input.adapterType !== "gemini_local" &&
      input.adapterType !== "opencode_local" &&
      input.adapterType !== "pi_local" &&
      input.adapterType !== "cursor" &&
      !hermesOverSsh
    ) ||
    input.environment.driver !== "ssh"
  ) {
    return null;
  }

  const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
    driver: input.environment.driver as "ssh",
    config: parseObject(input.environment.config),
  });
  if (parsed.driver !== "ssh") {
    return null;
  }

  const remoteCwd =
    typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
      ? input.leaseMetadata.remoteCwd.trim()
      : parsed.config.remoteWorkspacePath;

  if (hermesOverSsh) {
    // Never fall back to a local run: a refusal here fails the run.
    const decision = evaluateHermesSshEnvironment({
      companyId: input.companyId,
      config: parsed.config as unknown as Record<string, unknown>,
    });
    if (!decision.ok) throw new Error(decision.message);
    const identityFile = parsed.config.identityFile!;
    const knownHostsFile = parsed.config.knownHostsFile!;
    await assertHermesSshLaunchReady({ identityFile, knownHostsFile });
    const paperclipApiUrl =
      typeof input.leaseMetadata?.paperclipApiUrl === "string" && input.leaseMetadata.paperclipApiUrl.trim().length > 0
        ? input.leaseMetadata.paperclipApiUrl.trim()
        : null;
    return {
      kind: "remote",
      transport: "ssh",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      remoteCwd,
      paperclipApiUrl,
      spec: {
        host: parsed.config.host,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        // The dedicated identity file and pinned known_hosts replace any
        // stored key material or inline host keys.
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
        identityFile,
        knownHostsFile,
        remoteCwd,
        paperclipApiUrl,
      },
    };
  }

  return {
    kind: "remote",
    transport: "ssh",
    environmentId: input.environment.id ?? null,
    leaseId: input.leaseId ?? null,
    remoteCwd,
    paperclipApiUrl:
      typeof input.leaseMetadata?.paperclipApiUrl === "string" && input.leaseMetadata.paperclipApiUrl.trim().length > 0
        ? input.leaseMetadata.paperclipApiUrl.trim()
        : null,
    spec: {
      host: parsed.config.host,
      port: parsed.config.port,
      username: parsed.config.username,
      remoteWorkspacePath: parsed.config.remoteWorkspacePath,
      privateKey: parsed.config.privateKey,
      knownHosts: parsed.config.knownHosts,
      strictHostKeyChecking: parsed.config.strictHostKeyChecking,
      remoteCwd,
      paperclipApiUrl:
        typeof input.leaseMetadata?.paperclipApiUrl === "string" && input.leaseMetadata.paperclipApiUrl.trim().length > 0
          ? input.leaseMetadata.paperclipApiUrl.trim()
          : null,
    },
  };
}

export async function resolveEnvironmentExecutionTransport(
  input: Parameters<typeof resolveEnvironmentExecutionTarget>[0],
): Promise<Record<string, unknown> | null> {
  return adapterExecutionTargetToRemoteSpec(await resolveEnvironmentExecutionTarget(input)) as Record<string, unknown> | null;
}
