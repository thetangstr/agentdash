// AgentDash (AGE-58): WorkOSProvider — implements IAuthProvider for cloud Pro tier.
// Uses WorkOS AuthKit (free tier) for human auth + org membership.
// SSO / SCIM / Directory Sync are paid WorkOS features and are NOT wired here.

import type { Request } from "express";
import { WorkOS, DomainDataState } from "@workos-inc/node";
import type { IAuthProvider, AuthSession, OrgMember, OrgMemberRole } from "./provider.js";
import { FREE_MAIL_DOMAINS } from "@agentdash/shared";

// ---------------------------------------------------------------------------
// WorkOSProvider
// ---------------------------------------------------------------------------

export interface WorkOSProviderConfig {
  apiKey: string;
  clientId: string;
}

/**
 * Implements IAuthProvider against the WorkOS AuthKit (free tier).
 *
 * Key contracts:
 *  - signUp:       creates a WorkOS org for the email domain, creates the user,
 *                  and returns a DNS verification URL for the domain claim.
 *  - signIn:       authenticates via WorkOS User Management (password auth).
 *  - getSession:   validates the Authorization Bearer token against WorkOS.
 *  - inviteUser:   delegates to WorkOS Invitations API (WorkOS sends the email).
 *  - acceptInvite: accepts a WorkOS invitation by token.
 *  - listOrgMembers / addMember / removeMember: WorkOS Organization membership API.
 *
 * NOTE: AGE-59 will add an EmailService abstraction; for now WorkOS sends
 * invitation emails natively and no separate EmailService is needed.
 */
export function createWorkOSProvider(config: WorkOSProviderConfig): IAuthProvider {
  const workos = new WorkOS(config.apiKey, { clientId: config.clientId });

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  async function getSession(req: Request): Promise<AuthSession | null> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return null;
    }
    const token = authHeader.slice(7);
    try {
      const result = await workos.userManagement.authenticateWithSessionCookie({
        sessionData: token,
      });
      if (!result.authenticated) {
        return null;
      }
      const { user } = result;
      return {
        session: { id: token, userId: user.id },
        user: { id: user.id, email: user.email, name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null },
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // User lifecycle
  // -------------------------------------------------------------------------

  async function signUp(
    email: string,
    _password: string,
    _name?: string,
  ): Promise<{ userId: string }> {
    // Free-mail block: corp emails only for cloud Pro.
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain || FREE_MAIL_DOMAINS.has(domain)) {
      const err = new Error("pro_requires_corp_email");
      (err as NodeJS.ErrnoException).code = "pro_requires_corp_email";
      throw err;
    }

    // Create (or look up) a WorkOS Organization for the domain.
    // WorkOS will initiate domain DNS-verification; the verification URL
    // is surfaced in the response for the caller to present to the user.
    let orgId: string;
    let domainVerificationUrl: string | undefined;
    try {
      const org = await workos.organizations.createOrganization({
        name: domain,
        domainData: [{ domain, state: DomainDataState.Pending }],
      });
      orgId = org.id;
      // The domain record comes back with a verification URL when pending.
      const domainRecord = org.domains?.find((d) => d.domain === domain);
      domainVerificationUrl = (domainRecord as { verificationUrl?: string } | undefined)
        ?.verificationUrl;
    } catch (err: unknown) {
      // If the org already exists for the domain, fetch it.
      const existing = await workos.organizations
        .listOrganizations({ domains: [domain] })
        .then((list) => list.data[0] ?? null);
      if (!existing) throw err;
      orgId = existing.id;
    }

    // Create the WorkOS user.
    const user = await workos.userManagement.createUser({
      email,
      firstName: _name?.split(" ")[0],
      lastName: _name?.split(" ").slice(1).join(" ") || undefined,
      emailVerified: false,
    });

    // Add user as org admin (first signer-up owns the org).
    await workos.userManagement.createOrganizationMembership({
      organizationId: orgId,
      userId: user.id,
      roleSlug: "admin",
    });

    return {
      userId: user.id,
      // Surface the DNS verification URL for callers that need it.
      ...(domainVerificationUrl ? { domainVerificationUrl } : {}),
    } as { userId: string };
  }

  async function signIn(
    email: string,
    password: string,
  ): Promise<{ token: string }> {
    const result = await workos.userManagement.authenticateWithPassword({
      email,
      password,
      clientId: config.clientId,
    });
    // sealedSession is present when session cookie mode is enabled; fall back
    // to accessToken for callers using short-lived JWT mode.
    const token = result.sealedSession ?? result.accessToken;
    return { token };
  }

  async function signOut(_req: Request): Promise<void> {
    // WorkOS session termination is handled client-side by revoking the cookie.
    // Server-side there is no session store to purge for the free tier.
  }

  // -------------------------------------------------------------------------
  // Organisation membership
  // -------------------------------------------------------------------------

  async function inviteUser(
    orgId: string,
    email: string,
    role: OrgMemberRole = "member",
  ): Promise<{ inviteId: string }> {
    // WorkOS Invitations API sends the invite email natively.
    const invite = await workos.userManagement.sendInvitation({
      email,
      organizationId: orgId,
      roleSlug: role === "admin" ? "admin" : "member",
    });
    return { inviteId: invite.id };
  }

  async function acceptInvite(
    _token: string,
    _signupPayload: { name?: string; password?: string },
  ): Promise<{ userId: string }> {
    // WorkOS invitation acceptance is handled client-side via the AuthKit redirect
    // URL returned by inviteUser. The server does not process invitation tokens
    // directly in the free tier — the accepted user appears via the user.created
    // webhook (see auth-webhooks.ts). This method satisfies the interface contract.
    throw new Error(
      "WorkOSProvider.acceptInvite: WorkOS invitations are accepted client-side via AuthKit. " +
        "The accepted user is mirrored via the user.created webhook.",
    );
  }

  async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
    const list = await workos.userManagement.listOrganizationMemberships({
      organizationId: orgId,
    });
    const members: OrgMember[] = [];
    for (const membership of list.data) {
      const user = await workos.userManagement.getUser(membership.userId);
      const roleName = (membership.role as { slug?: string } | undefined)?.slug ?? "member";
      const role: OrgMemberRole = roleName === "admin" ? "admin" : "member";
      members.push({
        userId: user.id,
        email: user.email ?? null,
        name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null,
        role,
      });
    }
    return members;
  }

  async function addMember(orgId: string, userId: string, role: OrgMemberRole): Promise<void> {
    await workos.userManagement.createOrganizationMembership({
      organizationId: orgId,
      userId,
      roleSlug: role === "admin" ? "admin" : "member",
    });
  }

  async function removeMember(orgId: string, userId: string): Promise<void> {
    // Find the membership then delete it.
    const list = await workos.userManagement.listOrganizationMemberships({
      organizationId: orgId,
      userId,
    });
    const membership = list.data[0];
    if (!membership) return; // already removed — idempotent

    // Last-admin guard: reject if this is the sole admin.
    const allMembers = await workos.userManagement.listOrganizationMemberships({
      organizationId: orgId,
    });
    const adminCount = allMembers.data.filter(
      (m) => (m.role as { slug?: string } | undefined)?.slug === "admin",
    ).length;
    const isAdmin = (membership.role as { slug?: string } | undefined)?.slug === "admin";
    if (isAdmin && adminCount <= 1) {
      throw new Error("Cannot remove the last admin from an organisation");
    }

    await workos.userManagement.deleteOrganizationMembership(membership.id);
  }

  return {
    getSession,
    signUp,
    signIn,
    signOut,
    inviteUser,
    acceptInvite,
    listOrgMembers,
    addMember,
    removeMember,
  };
}
