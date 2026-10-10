import { it } from "vitest";
import { knownKeysFromEnv } from "../services/redact-secrets.ts";
import { redactSecrets } from "@paperclipai/shared";
it("env over-redaction", () => {
  const env = {
    PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/Users/kailor/.paperclip/instances/default/secrets/master.key",
    GOOGLE_APPLICATION_CREDENTIALS: "/Users/kailor/.config/gcloud/application_default_credentials.json",
    STRIPE_PUBLISHABLE_KEY: "pk_live_abcdefghijklmnopqrstuvwx",
    DATABASE_URL: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
    BETTER_AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz012345",
    PAPERCLIP_PUBLIC_KEY_URL: "https://agentdash.example.com/.well-known/jwks.json",
  } as any;
  const keys = knownKeysFromEnv(env);
  console.log("KEYS", keys.length, JSON.stringify(keys));
  for (const line of [
    "reading /Users/kailor/.paperclip/instances/default/data/run-logs/abc.ndjson",
    "cat /Users/kailor/.config/gcloud/application_default_credentials.json",
    "user paperclip connected to db paperclip",
    "GET https://agentdash.example.com/.well-known/jwks.json",
  ]) console.log(JSON.stringify(line), "=>", JSON.stringify(redactSecrets(line, keys)));
});
