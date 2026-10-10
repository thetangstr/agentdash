import { it } from "vitest";
import { redactSecrets } from "../redact-secrets.js";
it("p2", () => {
  for (const s of [
    `run: TOKEN=abc123xyz "next"`, `export GH_TOKEN=abc123xyz`, `TOKEN=abc123xyz`,
    `Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==`, `see agentdash.workspace.settings`,
    `const apiKey = process.env.API_KEY`, `password = getpass()`, `token: ${"$"}{TOKEN}`,
    `nextPageToken: "CgkIARABGgM"`, `{"taskKey":"t","publicKey":"ssh-ed25519 AAAA"}`,
    `curl -H "Authorization: Bearer abc\\"def123456" x`,
  ]) console.log(JSON.stringify(s), "=>", JSON.stringify(redactSecrets(s)));
});
