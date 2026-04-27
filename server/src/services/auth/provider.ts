// AgentDash (AGE-57): Provider-agnostic auth interface.
// All auth/membership operations in routes MUST go through this interface.
// No provider-specific imports outside server/src/services/auth/.

import type { Request } from "express";

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export type AuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type AuthSession = {
  session: { id: string; userId: string } | null;
  user: AuthSessionUser | null;
};

// ---------------------------------------------------------------------------
// Member types
// ---------------------------------------------------------------------------

export type OrgMemberRole = "admin" | "member";

export type OrgMember = {
  userId: string;
  email: string | null;
  name: string | null;
  role: OrgMemberRole;
};

// ---------------------------------------------------------------------------
// IAuthProvider interface
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic interface for auth and organisation membership operations.
 *
 * Implementations:
 *   - BetterAuthProvider  — self-hosted Free (current code path, no functional change)
 *   - WorkOSProvider      — cloud Pro (AGE-58, not yet implemented)
 *
 * Scope: human auth + org membership only.
 * Agent access control stays in agent_access_grants (AGE-63).
 */
export interface IAuthProvider {
  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  /** Resolve the session from an Express request (reads cookies / Bearer token). */
  getSession(req: Request): Promise<AuthSession | null>;

  // -------------------------------------------------------------------------
  // User lifecycle (handled by better-auth HTTP endpoints in BetterAuth impl)
  // -------------------------------------------------------------------------

  /**
   * Sign up a new user.
   * Returns the created user id on success.
   * Throws a provider-specific error if sign-up is disabled or email is taken.
   */
  signUp(email: string, password: string, name?: string): Promise<{ userId: string }>;

  /**
   * Sign in an existing user.
   * Returns the session token on success.
   */
  signIn(email: string, password: string): Promise<{ token: string }>;

  /**
   * Sign out the current session.
   */
  signOut(req: Request): Promise<void>;

  // -------------------------------------------------------------------------
  // Organisation membership
  // -------------------------------------------------------------------------

  /**
   * Invite a user by email to an organisation.
   * For BetterAuth: creates an invite record in the local DB.
   * For WorkOS: delegates to WorkOS Invitations API.
   */
  inviteUser(orgId: string, email: string, role?: OrgMemberRole): Promise<{ inviteId: string }>;

  /**
   * Accept a pending invitation.
   * `token` is the invite token; `signupPayload` carries name/password for new users.
   */
  acceptInvite(
    token: string,
    signupPayload: { name?: string; password?: string },
  ): Promise<{ userId: string }>;

  /**
   * List all members of an organisation.
   */
  listOrgMembers(orgId: string): Promise<OrgMember[]>;

  /**
   * Add a user to an organisation with the given role.
   * Used by the join-request approval flow.
   */
  addMember(orgId: string, userId: string, role: OrgMemberRole): Promise<void>;

  /**
   * Remove a user from an organisation.
   * Implementations MUST enforce the last-admin guard.
   */
  removeMember(orgId: string, userId: string): Promise<void>;
}
