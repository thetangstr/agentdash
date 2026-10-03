// AgentDash (GH #992): the pattern set moved to `packages/shared` so the UI's
// display hygiene and the server's run-log redaction share one implementation.
// Server-side persistence redacts before storage; this re-export keeps the
// existing UI import paths working.
export {
  REDACTED,
  CREDENTIALS_HIDDEN_NOTE,
  isSecretName,
  redactSecrets,
  containsSecrets,
  redactSecretsInValue,
} from "@paperclipai/shared";
