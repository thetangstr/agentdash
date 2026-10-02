// AgentDash: Phase-1 EC2 driver (spike R4). One EC2 instance per company;
// every lifecycle op is an SSM SendCommand running sandbox-ctl inside the
// guest, followed by GetCommandInvocation to read the JSON result. Instance
// lifecycle (create/start/stop for the warm pool) is documented here but the
// pool manager is the provisioner's job, not this driver's.
//
// This class NEVER constructs a real AWS client: `SsmLike`/`Ec2Like` are
// injected, so wiring it to @aws-sdk is an explicit decision at the call site
// (Phase 1), and in this spike the only client that exists is the test
// recorder. The mapping below IS the documented call plan.
//
// Call plan per operation:
//   openHandshake        SSM SendCommand(AWS-RunShellScript,
//                        "node /opt/sandbox/sandbox-ctl.mjs open-handshake {…}")
//                        then GetCommandInvocation -> stdout JSON
//   listHandshakes       same channel, "list-handshakes"
//   applyRunConfig       same channel, "apply-run-config"
//   installSinkToken     same channel, "install-sink-token"
//   clear                same channel, "clear" (always callable)
//   guestEvidence        same channel, "gen-evidence"
//   (provisioner, not   EC2 RunInstances(ami, IamInstanceProfile, tags)
//    this driver)       → wait running → SSM inventory; warm pool =
//                        StopInstances, claim = StartInstances + wait
import {
  SandboxOpError,
  type GuestEvidence,
  type SandboxDriver,
  type SandboxEnvironment,
  type SandboxHealth,
} from "./driver.js";
import type {
  ApplyRunConfigResponse,
  ClearResponse,
  ListHandshakesResponse,
  OpenHandshakeResponse,
} from "./schemas.js";

/** Subset of @aws-sdk/client-ssm used here — injectable, mockable. */
export interface SsmLike {
  sendCommand(input: {
    DocumentName: "AWS-RunShellScript";
    InstanceIds: string[];
    Parameters: { commands: string[] };
    Comment?: string;
  }): Promise<{ Command?: { CommandId?: string } }>;
  getCommandInvocation(input: {
    CommandId: string;
    InstanceId: string;
  }): Promise<{ Status?: string; StandardOutputContent?: string; StandardErrorContent?: string }>;
}

/** Subset of @aws-sdk/client-ec2 used for environment description. */
export interface Ec2Like {
  describeInstances(input: { InstanceIds: string[] }): Promise<{
    Reservations?: Array<{ Instances?: Array<{ InstanceId?: string; ImageId?: string; State?: { Name?: string } }> }>;
  }>;
}

const CTL = "node /opt/sandbox/sandbox-ctl.mjs --state /run/sandbox --socket /run/sandbox-signer/sign.sock";
const POLL_MS = 200;
const POLL_TIMEOUT_MS = 30_000;

export class Ec2Driver implements SandboxDriver {
  constructor(
    private readonly opts: {
      instanceId: string;
      ssm: SsmLike;
      ec2: Ec2Like;
      /** e.g. "ec2:i-0123…/us-east-1" */
      environmentId: string;
      imageDigest: string;
      /** Injectable for tests. */
      pollMs?: number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  environment(): SandboxEnvironment {
    return { environmentId: this.opts.environmentId, imageDigest: this.opts.imageDigest };
  }

  /** SendCommand one sandbox-ctl call and wait for its JSON stdout. */
  private async ctl(cmd: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const shell = `${CTL} ${cmd} '${JSON.stringify(input).replaceAll("'", "'\\''")}'`;
    const sent = await this.opts.ssm.sendCommand({
      DocumentName: "AWS-RunShellScript",
      InstanceIds: [this.opts.instanceId],
      Parameters: { commands: [shell] },
      Comment: `sandbox-ctl ${cmd}`,
    });
    const commandId = sent.Command?.CommandId;
    if (!commandId) throw new SandboxOpError("ssm_error", "SendCommand returned no CommandId");

    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const inv = await this.opts.ssm.getCommandInvocation({
        CommandId: commandId,
        InstanceId: this.opts.instanceId,
      });
      if (inv.Status === "Success") {
        const line = (inv.StandardOutputContent ?? "").trim().split("\n").pop() ?? "{}";
        const parsed = JSON.parse(line) as { ok?: boolean; error?: { code: string; message: string } };
        if (parsed.ok === false) {
          throw new SandboxOpError(parsed.error?.code ?? "guest_error", parsed.error?.message ?? "guest error");
        }
        return parsed as Record<string, unknown>;
      }
      if (inv.Status === "Failed" || inv.Status === "Cancelled" || inv.Status === "TimedOut") {
        throw new SandboxOpError(
          "ssm_command_failed",
          `SendCommand ${commandId} ${inv.Status}: ${inv.StandardErrorContent ?? ""}`,
        );
      }
      if (Date.now() > deadline) throw new SandboxOpError("ssm_timeout", `command ${commandId} still ${inv.Status}`);
      await sleep(this.opts.pollMs ?? POLL_MS);
    }
  }

  async openHandshake(input: { side: "buyer" | "seller"; sessionId?: string }): Promise<OpenHandshakeResponse> {
    return (await this.ctl("open-handshake", input)) as unknown as OpenHandshakeResponse;
  }

  async listHandshakes(): Promise<ListHandshakesResponse> {
    const r = await this.ctl("list-handshakes", {});
    return { sessions: r.sessions as ListHandshakesResponse["sessions"] };
  }

  async applyRunConfig(input: {
    runId: string;
    sessionId: string;
    agentConfigRevision?: string;
  }): Promise<ApplyRunConfigResponse> {
    return (await this.ctl("apply-run-config", input)) as unknown as ApplyRunConfigResponse;
  }

  async installSinkToken(input: { runId: string; sealedTokenB64: string }): Promise<{ tokenDigest: string }> {
    const r = await this.ctl("install-sink-token", input);
    return { tokenDigest: String(r.tokenDigest) };
  }

  async clear(input: { runId?: string }): Promise<ClearResponse> {
    const r = await this.ctl("clear", input);
    return { cleared: true, clearedAt: String(r.clearedAt) };
  }

  async guestEvidence(input: { runId: string }): Promise<GuestEvidence> {
    return (await this.ctl("gen-evidence", input)) as unknown as GuestEvidence;
  }

  async health(): Promise<SandboxHealth> {
    return (await this.ctl("health", {})) as unknown as SandboxHealth;
  }

  async dispose(): Promise<void> {
    // SSM is a managed channel; nothing local to release.
  }
}

/**
 * The AWS resources and API calls Phase 1 needs — exported as data so the
 * SPIKE document and any future provisioner share one list. Nothing here is
 * executed; it is the reference the founder's run-book quotes.
 */
export const EC2_PHASE1_PLAN = {
  instances: {
    instanceType: "t4g.large (Graviton, 2 vCPU / 8 GiB) — one per company",
    ami: "sandbox AMI baked from cloud/sandbox layout (Packer/Image Builder), pinned by digest",
    rootVolume: "gp3 20 GiB, encrypted, deleted on terminate",
    network:
      "default VPC ok for Phase 1; SG inbound = none (SSM is outbound-only); " +
      "SG egress narrowed to tcp 443 + udp/tcp 53 — nftables per-uid is the fine-grained enforcement",
    imds: "IMDSv2 required, hop limit 1",
    warmPool: "N stopped instances per active company tag; claim = StartInstances + wait running",
  },
  apiCalls: {
    provision: ["ec2:RunInstances", "ec2:CreateTags", "ec2:Waiters(instanceRunning)", "ssm:DescribeInstanceInformation"],
    claimFromPool: ["ec2:StartInstances", "ec2:Waiters(instanceRunning)", "ssm:SendCommand(health)"],
    lifecycle: ["ssm:SendCommand", "ssm:GetCommandInvocation"],
    park: ["ec2:StopInstances"],
    teardown: ["ec2:TerminateInstances"],
  },
  iam: {
    instanceRole:
      "sandbox-instance-role: AmazonSSMManagedInstanceCore + kms:Sign/kms:GetPublicKey on the " +
      "company's key (key policy scopes it per-company) — no s3, no secretsmanager",
    controlPlaneRole:
      "sandbox-control-role (control plane): ec2:RunInstances/StartInstances/StopInstances/" +
      "TerminateInstances/DescribeInstances/CreateTags on tag company=*, ssm:SendCommand/" +
      "GetCommandInvocation on instance i-* + document AWS-RunShellScript, iam:PassRole on " +
      "sandbox-instance-role only",
  },
} as const;
