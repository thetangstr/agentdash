import { describe, expect, it, vi } from "vitest";
vi.mock("../services/hermes-provider-setup.js", () => ({ configuredProviderKeysSync: () => [] }));
vi.mock("../services/redact-secrets.js", () => ({ knownKeysFromEnv: () => ["fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls"] }));
import { redactRecoveryEvidenceTextAsync } from "../services/recovery/service.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactSensitiveText } from "../redaction.js";
import { redactRunLogText } from "../services/run-log-redaction.js";

describe("recovery evidence tail redaction", () => {
  it("retains the legacy midline-tail privacy policy while yielding", async () => {
    const options = { userNames: ["fixture-person"], homeDirs: ["/Users/fixture-person"] };
    const input = ('partial record... ' + 'ordinary ✓\n'.repeat(500) +
      '/Users/fixture-person fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls API_KEY="synthetic-secret-9876"\n').slice(-8192);
    const expected = redactRunLogText(redactSensitiveText(redactCurrentUserText(input, options)));
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const output = await redactRecoveryEvidenceTextAsync(input, options, { sliceMs: 0 });
    expect(output).toBe(expected);
    expect(yielded).toBe(true);
    expect(output).not.toContain("fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls");
    expect(output).not.toContain("synthetic-secret-9876");
    expect(output).not.toContain("/Users/fixture-person");
    expect(output).toContain("partial record... ordinary ✓");
  });
});
