// AgentDash (AGE-59): EmailService factory.
// Selects the backend based on EMAIL_BACKEND env, with a sensible default
// derived from AUTH_PROVIDER (better-auth → relay; workos → workos).

import type { Db } from "@agentdash/db";
import type { EmailService } from "./email-service.js";
import { AgentDashRelayEmailService } from "./relay-email-service.js";
import { WorkOSEmailService } from "./workos-email-service.js";

export type { EmailService } from "./email-service.js";
export { EmailRelayUnavailableError } from "./email-service.js";
export type {
  SendInvitePayload,
  SendJoinRequestNotificationPayload,
  SendWelcomePayload,
} from "./email-service.js";

export type EmailBackend = "relay" | "workos";

export interface EmailServiceConfig {
  /**
   * Which backend to use. Defaults to "relay" when AUTH_PROVIDER=better-auth
   * and "workos" when AUTH_PROVIDER=workos.
   */
  emailBackend: EmailBackend;
  /** URL of the AgentDash relay endpoint (relay backend only). */
  emailRelayUrl?: string;
  /** Stable identifier for this AgentDash instance (relay backend only). */
  emailRelayInstanceId?: string;
  /** HMAC signing key for relay payloads (relay backend only). */
  emailRelaySigningKey?: string;
  /** Resend API key (workos backend only). */
  resendApiKey?: string;
}

/**
 * Instantiate the EmailService selected by configuration.
 *
 * @param config    - EmailServiceConfig (read from server config / env).
 * @param db        - Drizzle DB instance (for activity logging).
 * @param companyId - Company scope for activity log entries.
 */
export function createEmailService(
  config: EmailServiceConfig,
  db: Db,
  companyId: string,
): EmailService {
  switch (config.emailBackend) {
    case "relay": {
      const instanceId = config.emailRelayInstanceId ?? "default";
      const signingKey = config.emailRelaySigningKey ?? "";
      return new AgentDashRelayEmailService(
        {
          relayUrl: config.emailRelayUrl,
          instanceId,
          signingKey,
        },
        db,
        companyId,
      );
    }

    case "workos": {
      const resendApiKey = config.resendApiKey ?? "";
      return new WorkOSEmailService({ resendApiKey }, db, companyId);
    }

    default: {
      const _exhaustive: never = config.emailBackend;
      throw new Error(`Unknown EMAIL_BACKEND value: ${String(_exhaustive)}`);
    }
  }
}
