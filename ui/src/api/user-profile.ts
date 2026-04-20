// AgentDash: user-profile API wrapper
//
// Scope note: the AgentDash backend currently only exposes a session endpoint
// (`/api/auth/get-session` via BetterAuth). There is no user preferences table,
// no user-facing board-API-key list/create/revoke route, and no DELETE /api/me.
// This wrapper therefore surfaces only the session-derived identity.
//
// Preferences are persisted in localStorage under `agentdash.user.preferences`
// (see the UserProfile page). Account deletion is gated behind an admin contact
// message in the UI — there is no self-service delete route to call.

import { authApi, type AuthSession } from "./auth";

export interface UserProfile {
  id: string;
  email: string | null;
  name: string | null;
}

function sessionToProfile(session: AuthSession | null): UserProfile | null {
  if (!session) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  };
}

export const userProfileApi = {
  getMe: async (): Promise<UserProfile | null> => {
    const session = await authApi.getSession();
    return sessionToProfile(session);
  },
};
