// AgentDash (AGE-59): EmailService interface + typed error class.
// All transactional email in the server goes through this interface.
// Two implementations: AgentDashRelayEmailService (self-hosted Free)
// and WorkOSEmailService (cloud Pro). Selected by createEmailService().

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown by AgentDashRelayEmailService when the AgentDash-hosted Resend relay
 * is unreachable (network error, 4xx, 5xx, or timeout).
 *
 * Callers (e.g. the invite-create route) should catch this and fall back to
 * returning the invite link in the response body so the admin can share it
 * manually.
 */
export class EmailRelayUnavailableError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "EmailRelayUnavailableError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface SendInvitePayload {
  to: string;
  orgName: string;
  inviteUrl: string;
  expiresAt: Date;
}

export interface SendJoinRequestNotificationPayload {
  to: string;
  orgName: string;
  requesterEmail: string;
  approveUrl: string;
}

export interface SendWelcomePayload {
  to: string;
  orgName: string;
  name: string;
}

// ---------------------------------------------------------------------------
// EmailService interface
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic interface for transactional email.
 *
 * Implementations:
 *   - AgentDashRelayEmailService — self-hosted Free: POSTs to AgentDash relay
 *   - WorkOSEmailService         — cloud Pro: WorkOS Invitations + direct Resend
 */
export interface EmailService {
  /**
   * Send a human-invitation email.
   * Self-hosted: sends via AgentDash Resend relay.
   * Cloud: delegates to WorkOS Invitations API (WorkOS sends the email).
   */
  sendInvite(payload: SendInvitePayload): Promise<void>;

  /**
   * Notify the admin that a new join request is pending approval.
   */
  sendJoinRequestNotification(
    payload: SendJoinRequestNotificationPayload,
  ): Promise<void>;

  /**
   * Send a welcome email to a new member after they successfully join.
   */
  sendWelcome(payload: SendWelcomePayload): Promise<void>;
}
