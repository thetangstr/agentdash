import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretsAsync } from "./redact-secrets.js";

const SECRET = "fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls";
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
const options = { sliceMs: 0, yieldToEventLoop: pause };
describe("cooperative shared redaction", () => {
  it("matches existing policy across multiline, escaped, normalized and scan-boundary adversarial inputs", async () => {
    const samples = [
      `before\n${SECRET}\nafter`,
      'before\nfirst secret\nsecond secret\nafter',
      '-----BEGIN PRIVATE KEY-----\nsecretbody\n-----END PRIVATE KEY-----',
      'password="first line\nsecond line"',
      '{"api\\u005fkey":"synthetic-secret-4321","text":"👩‍💻 ordinary"}',
      JSON.stringify({ chunk: 'API_KEY="ab\\cd\\\"ef-secret-123" 👩‍💻' }),
      `prefix ${"ordinary progress ✓\n".repeat(60_000)}API_KEY=${SECRET}\nend`,
      `password="${"z".repeat(12_000)}"\n benign`,
      'mysql -phunter99\n'.repeat(400),
      '-b a=\n'.repeat(400),
      'Authorization: Bearer sk-proj-Synthetic12345678\n'.repeat(400),
    ];
    for (const sample of samples) {
      const known = [SECRET, "first secret\nsecond secret"];
      const expected = redactSecrets(sample, known);
      const result = await redactSecretsAsync(sample, known, options);
      expect(result).toBe(expected);
      expect(result).not.toContain(SECRET);
      expect(result).not.toContain("first secret\nsecond secret");
    }
  });

  it("keeps request cursors independent from concurrent async and synchronous scans", async () => {
    const a = `API_KEY=${SECRET}\n`.repeat(700);
    const b = 'password="different-synthetic-4432"\n'.repeat(700);
    const expectedA = redactSecrets(a, [SECRET]);
    const expectedB = redactSecrets(b, [SECRET]);
    const result = await Promise.all([
      redactSecretsAsync(a, [SECRET], { ...options, yieldToEventLoop: async () => {
        expect(redactSecrets(b, [SECRET])).toBe(expectedB);
        await pause();
      } }),
      redactSecretsAsync(b, [SECRET], options),
    ]);
    expect(result).toEqual([expectedA, expectedB]);
  });

  it("yields during normalization even when no pattern matches and honors pre-abort", async () => {
    const input = "ordinary progress ✓\n".repeat(10_000);
    let yielded = false;
    setImmediate(() => { yielded = true; });
    expect(await redactSecretsAsync(input, [], options)).toBe(input);
    expect(yielded).toBe(true);
    const signal = AbortSignal.abort();
    await expect(redactSecretsAsync("small", [], { signal })).rejects.toThrow();
  });
});
