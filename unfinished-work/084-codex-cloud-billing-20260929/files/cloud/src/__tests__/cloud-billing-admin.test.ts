// AgentDash: SC-8 private operator commands never accept secrets as argv or echo them.
import { describe, expect, it, vi } from "vitest";
import { runAdmin } from "../admin/run.js";

describe("Stripe operator CLI", () => {
  const env = { CLOUD_ADMIN_TOKEN: "offlineadmin", CLOUD_CONTROL_URL: "http://localhost:3200" };
  it("reads the fleet restricted key only from stdin", async () => {
    const output: string[] = []; const errors: string[] = [];
    const f = vi.fn(async (_url, options) => { expect(JSON.parse(String(options?.body))).toEqual({ key: "rk_test_offlineboxes" }); return new Response('{"updated":["blue-box"],"failed":[]}'); });
    expect(await runAdmin(["stripe", "rotate-box-key"], env, { out: (l) => output.push(l), err: (l) => errors.push(l), fetch: f, readStdin: async () => "rk_test_offlineboxes\n" })).toBe(0);
    expect(f).toHaveBeenCalledOnce(); expect(output.join()).not.toContain("rk_test_offlineboxes"); expect(errors).toEqual([]);
  });
  it("refuses positional keys and does not echo transport/provider secrets", async () => {
    const out: string[] = []; const f = vi.fn(async () => new Response('rk_test_offlineboxes', { status: 500 }));
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l), fetch: f, readStdin: async () => "rk_test_offlineboxes" };
    expect(await runAdmin(["stripe", "rotate-box-key", "rk_test_offlineboxes"], env, io)).toBe(2); expect(f).not.toHaveBeenCalled();
    expect(await runAdmin(["stripe", "rotate-box-key"], env, io)).toBe(1); expect(out.join()).not.toContain("rk_test_offlineboxes");
  });
  it("requires one restricted key and explicit endpoint configuration command", async () => {
    const f = vi.fn(async () => new Response('{"id":"we_offline","url":"https://www.agentdash.cloud/api/cloud/stripe/webhook"}'));
    const io = { out: vi.fn(), err: vi.fn(), fetch: f, readStdin: async () => "sk_test_wrong" };
    expect(await runAdmin(["stripe", "rotate-box-key"], env, io)).toBe(2); expect(f).not.toHaveBeenCalled();
    expect(await runAdmin(["stripe", "configure-webhook"], env, io)).toBe(0);
  });
});
