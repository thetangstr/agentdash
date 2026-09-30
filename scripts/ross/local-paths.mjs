import { homedir } from 'node:os';
import { join } from 'node:path';

// Operator-local install locations. Defaults follow the standard Hermes layout
// under the current user's home; override per host without editing scripts.
export function hermesAgentRoot() {
  return process.env.ROSS_HERMES_AGENT_ROOT || join(homedir(), '.hermes', 'hermes-agent');
}

// Existing provider dotenv the explicit pilot runner reads GLM_API_KEY from.
export function hermesProviderEnvFile() {
  return process.env.ROSS_PROVIDER_ENV_FILE || join(homedir(), '.hermes', '.env');
}
