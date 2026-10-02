// AgentDash: the local "fake VM" driver (spike R4). It is fake about the
// machine (a temp dir, not an instance) and honest about the guest: every
// lifecycle op runs the real cloud/sandbox/sandbox-ctl.mjs against a real
// signerd subprocess on a real unix socket. That makes the tests of the
// lifecycle service also an end-to-end test of the in-image agent.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  ApplyRunConfigResponse,
  ClearResponse,
  ListHandshakesResponse,
  OpenHandshakeResponse,
} from "./schemas.js";
import {
  SandboxOpError,
  type GuestEvidence,
  type SandboxDriver,
  type SandboxEnvironment,
  type SandboxHealth,
} from "./driver.js";

const execFileP = promisify(execFile);

const SANDBOX_DIR = fileURLToPath(new URL("../../../sandbox", import.meta.url));
const CTL = join(SANDBOX_DIR, "sandbox-ctl.mjs");
const SIGNERD = join(SANDBOX_DIR, "signerd.mjs");
const POLICY = join(SANDBOX_DIR, "signer-policy.json");

export interface LocalVmDriverOpts {
  /** Reuse an existing dir (tests may share one VM across cases). */
  stateDir?: string;
  /** Fixed environment id; default "localvm:<uuid>". */
  environmentId?: string;
  imageDigest?: string;
}

export class LocalVmDriver implements SandboxDriver {
  readonly stateDir: string;
  readonly socketPath: string;
  private readonly env: SandboxEnvironment;
  private signerd: ChildProcess | null = null;

  private constructor(opts: LocalVmDriverOpts) {
    this.stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "sandbox-vm-"));
    this.socketPath = join(this.stateDir, "sign.sock");
    this.env = {
      environmentId: opts.environmentId ?? `localvm:${randomUUID()}`,
      imageDigest: opts.imageDigest ?? "local-sandbox:dev",
    };
  }

  /** Boot the fake VM: state dir, key file, signerd subprocess. */
  static async boot(opts: LocalVmDriverOpts = {}): Promise<LocalVmDriver> {
    const d = new LocalVmDriver(opts);
    mkdirSync(join(d.stateDir, "signer"), { recursive: true });
    const keyFile = join(d.stateDir, "signer", "signing-key.pem");
    d.signerd = spawn(
      process.execPath,
      [SIGNERD, "--socket", d.socketPath, "--policy", POLICY, "--key-file", keyFile, "--generate"],
      { env: { ...process.env, SANDBOX_DEV: "1" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    await d.waitForSocket();
    return d;
  }

  environment(): SandboxEnvironment {
    return this.env;
  }

  private waitForSocket(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const deadline = Date.now() + 10_000;
      this.signerd?.once("exit", (code) => reject(new Error(`signerd exited ${code}`)));
      const probe = () => {
        if (existsSync(this.socketPath)) resolvePromise();
        else if (Date.now() > deadline) reject(new Error("signerd socket never appeared"));
        else setTimeout(probe, 25);
      };
      probe();
    });
  }

  /** Invoke the in-guest agent exactly as the image does. */
  private async ctl(cmd: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    let stdout = "";
    try {
      ({ stdout } = await execFileP(
        process.execPath,
        [CTL, "--state", this.stateDir, "--socket", this.socketPath, cmd, JSON.stringify(input)],
        { env: { ...process.env, SANDBOX_DEV: "1" }, timeout: 15_000 },
      ));
    } catch (err) {
      // The guest writes {ok:false,error:{...}} on stdout then exits 1 — a
      // non-zero exit carries the structured error, parse it back out.
      stdout = (err as { stdout?: string }).stdout ?? "";
      if (!stdout.trim()) throw err;
    }
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown> & {
      ok?: boolean;
      error?: { code: string; message: string };
    };
    if (parsed.ok === false) {
      throw new SandboxOpError(parsed.error?.code ?? "guest_error", parsed.error?.message ?? "guest error");
    }
    return parsed;
  }

  async openHandshake(input: { side: "buyer" | "seller"; sessionId?: string }): Promise<OpenHandshakeResponse> {
    const r = await this.ctl("open-handshake", input);
    return {
      sessionId: String(r.sessionId),
      side: r.side as "buyer" | "seller",
      state: "open",
      openedAt: String(r.openedAt),
    };
  }

  async listHandshakes(): Promise<ListHandshakesResponse> {
    const r = await this.ctl("list-handshakes");
    return { sessions: r.sessions as ListHandshakesResponse["sessions"] };
  }

  async applyRunConfig(input: {
    runId: string;
    sessionId: string;
    agentConfigRevision?: string;
  }): Promise<ApplyRunConfigResponse> {
    const r = await this.ctl("apply-run-config", input);
    return {
      runId: String(r.runId),
      sessionId: String(r.sessionId),
      signerPublicKeyPem: String(r.signerPublicKeyPem),
      adapterPublicKeyPem: String(r.adapterPublicKeyPem),
      forwarderSealingPublicKeyB64: String(r.forwarderSealingPublicKeyB64),
    };
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
    // Dev mode needs the key-file path passed through; it lives under the
    // state dir on the fake VM.
    const { stdout } = await execFileP(
      process.execPath,
      [CTL, "--state", this.stateDir, "--socket", this.socketPath,
       "--key-file", join(this.stateDir, "signer", "signing-key.pem"), "health"],
      { env: { ...process.env, SANDBOX_DEV: "1" }, timeout: 15_000 },
    ).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }));
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as SandboxHealth;
  }

  async dispose(): Promise<void> {
    this.signerd?.kill();
    this.signerd = null;
  }
}
