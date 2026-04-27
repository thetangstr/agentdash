// AgentDash (AGE-57): Auth provider factory.
// This is the ONLY place that imports provider implementations and selects
// between them. Import { createAuthProvider } from here in route/app code.

import type { Request } from "express";
import type { Db } from "@agentdash/db";
import type { IAuthProvider, AuthSession } from "./provider.js";
import { createBetterAuthProvider } from "./better-auth-provider.js";

export type { IAuthProvider, AuthSession, AuthSessionUser, OrgMember, OrgMemberRole } from "./provider.js";

/**
 * Instantiate the IAuthProvider selected by AUTH_PROVIDER env (via config).
 *
 * @param authProvider - "better-auth" | "workos" from config.authProvider
 * @param db           - Drizzle DB instance
 * @param resolveSession - For "better-auth": a function that resolves the
 *                         better-auth session from an Express request.
 *                         Provided by the server boot path (index.ts).
 *
 * @throws if AUTH_PROVIDER=workos — AGE-58 will implement WorkOSProvider.
 */
export function createAuthProvider(
  authProvider: "better-auth" | "workos",
  db: Db,
  resolveSession: (req: Request) => Promise<AuthSession | null>,
): IAuthProvider {
  switch (authProvider) {
    case "better-auth":
      return createBetterAuthProvider(db, resolveSession);

    case "workos":
      // AGE-58 will drop in the WorkOSProvider here.
      throw new Error(
        "WorkOSProvider is not yet implemented. " +
          "Set AUTH_PROVIDER=better-auth (default) or wait for AGE-58.",
      );

    default: {
      // TypeScript exhaustiveness check — should never reach here at runtime.
      const _exhaustive: never = authProvider;
      throw new Error(`Unknown AUTH_PROVIDER value: ${String(_exhaustive)}`);
    }
  }
}
