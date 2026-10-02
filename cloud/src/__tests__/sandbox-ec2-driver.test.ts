// AgentDash: the EC2 driver's AWS-call mapping (spike R4). The only clients
// ever injected here are recorders — the point of the test is that every
// lifecycle op lands as the documented SendCommand against the right
// instance, and nothing else AWS-shaped happens.
import { describe, expect, it } from "vitest";
import { Ec2Driver, type SsmLike } from "../sandbox/lifecycle/ec2-driver.js";

interface Recorded {
  op: string;
  input: unknown;
}

function fakeSsm(stdoutFor: (commands: string[]) => string): { ssm: SsmLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const ssm: SsmLike = {
    sendCommand: async (input) => {
      calls.push({ op: "SendCommand", input });
      return { Command: { CommandId: `cmd-${calls.length}` } };
    },
    getCommandInvocation: async (input) => {
      calls.push({ op: "GetCommandInvocation", input });
      const sent = calls.find((c) => c.op === "SendCommand");
      const cmds = (sent?.input as { Parameters: { commands: string[] } }).Parameters.commands;
      return { Status: "Success", StandardOutputContent: stdoutFor(cmds) + "\n" };
    },
  };
  return { ssm, calls };
}

function driver(stdoutFor: (commands: string[]) => string) {
  const { ssm, calls } = fakeSsm(stdoutFor);
  const d = new Ec2Driver({
    instanceId: "i-0deadbeef",
    ssm,
    ec2: { describeInstances: async () => ({ Reservations: [] }) },
    environmentId: "ec2:i-0deadbeef/us-east-1",
    imageDigest: "sha256:abc123",
    sleep: async () => {},
  });
  return { d, calls };
}

describe("Ec2Driver", () => {
  it("openHandshake maps to a sandbox-ctl SendCommand on the instance", async () => {
    const { d, calls } = driver(() =>
      JSON.stringify({ ok: true, sessionId: "s-1", side: "buyer", state: "open", openedAt: "t" }),
    );
    const res = await d.openHandshake({ side: "buyer" });
    expect(res.sessionId).toBe("s-1");
    const send = calls.find((c) => c.op === "SendCommand");
    expect(send).toBeDefined();
    const input = send!.input as { DocumentName: string; InstanceIds: string[]; Parameters: { commands: string[] } };
    expect(input.DocumentName).toBe("AWS-RunShellScript");
    expect(input.InstanceIds).toEqual(["i-0deadbeef"]);
    expect(input.Parameters.commands[0]).toContain("sandbox-ctl.mjs");
    expect(input.Parameters.commands[0]).toContain("open-handshake");
    expect(input.Parameters.commands[0]).toContain('"side":"buyer"');
  });

  it("clear is sent the same way and returns clearedAt", async () => {
    const { d, calls } = driver(() => JSON.stringify({ ok: true, clearedAt: "2026-10-02T00:00:00Z" }));
    const res = await d.clear({ runId: "r1" });
    expect(res.cleared).toBe(true);
    const send = calls.find((c) => c.op === "SendCommand")!.input as { Parameters: { commands: string[] } };
    expect(send.Parameters.commands[0]).toContain("clear");
    expect(send.Parameters.commands[0]).toContain('"runId":"r1"');
  });

  it("surfaces guest errors as SandboxOpError", async () => {
    const { d } = driver(() => JSON.stringify({ ok: false, error: { code: "unknown_session", message: "nope" } }));
    await expect(d.applyRunConfig({ runId: "r", sessionId: "nope" })).rejects.toMatchObject({
      name: "SandboxOpError",
      code: "unknown_session",
    });
  });

  it("surfaces SSM command failure", async () => {
    const calls: Recorded[] = [];
    const ssm: SsmLike = {
      sendCommand: async (input) => (calls.push({ op: "SendCommand", input }), { Command: { CommandId: "c1" } }),
      getCommandInvocation: async () => ({ Status: "Failed", StandardErrorContent: "boom" }),
    };
    const d = new Ec2Driver({
      instanceId: "i-1", ssm, ec2: { describeInstances: async () => ({}) },
      environmentId: "ec2:i-1/us-east-1", imageDigest: "sha256:x", sleep: async () => {},
    });
    await expect(d.listHandshakes()).rejects.toMatchObject({ code: "ssm_command_failed" });
  });

  it("polls until the invocation completes", async () => {
    const calls: Recorded[] = [];
    let polls = 0;
    const ssm: SsmLike = {
      sendCommand: async () => ({ Command: { CommandId: "c9" } }),
      getCommandInvocation: async () => {
        polls++;
        return polls < 3
          ? { Status: "InProgress" }
          : { Status: "Success", StandardOutputContent: JSON.stringify({ ok: true, sessions: [] }) };
      },
    };
    void calls;
    const d = new Ec2Driver({
      instanceId: "i-2", ssm, ec2: { describeInstances: async () => ({}) },
      environmentId: "ec2:i-2/us-east-1", imageDigest: "sha256:x", sleep: async () => {},
    });
    const res = await d.listHandshakes();
    expect(res.sessions).toEqual([]);
    expect(polls).toBe(3);
  });
});
