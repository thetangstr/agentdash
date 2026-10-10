import { it } from "vitest";
import { redactSecrets } from "../redact-secrets.js";
const K = "f3b9c2d1e4a5968778a1b2c3.Qz9XyW8vU7tS";
it("p3", () => {
  for (const s of [
    `run: TOKEN=abc123xyz "next"`, `run: TOKEN=abc123xyz`, `echo TOKEN=abc123xyz "next"`, `TOKEN=abc123xyz "x"`,
    `run: ZAI_API_KEY=${K}`, `step: export ZAI_API_KEY=${K} && ok`, `note: API_KEY=${K}`, `x: password=hunter2pass`,
    `ERROR: invalid api_key=${K}`, `foo: bar ZAI_API_KEY=${K}`,
  ]) console.log(JSON.stringify(s), "=>", JSON.stringify(redactSecrets(s)));
});
