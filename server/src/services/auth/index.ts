// AgentDash (AGE-57): Auth provider factory.
// This is the ONLY place that imports provider implementations and selects
// between them. Import { createAuthProvider } from here in route/app code.

import type { Request } from "express";
import type { Db } from "@agentdash/db";
import type { IAuthProvider, AuthSession } from "./provider.js";
import { createBetterAuthProvider } from "./better-auth-provider.js";
// AgentDash (AGE-58): WorkOS cloud Pro provider.
import { createWorkOSProvider } from "./workos-provider.js";

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
 * @throws if AUTH_PROVIDER=workos and required WorkOS env vars are missing.
 */
export function createAuthProvider(
  authProvider: "better-auth" | "workos",
  db: Db,
  resolveSession: (req: Request) => Promise<AuthSession | null>,
): IAuthProvider {
  switch (authProvider) {
    case "better-auth":
      return createBetterAuthProvider(db, resolveSession);

    case "workos": {
      // AgentDash (AGE-58): Boot-time env validation — fail fast with a clear message.
      const apiKey = process.env.WORKOS_API_KEY?.trim();
      const clientId = process.env.WORKOS_CLIENT_ID?.trim();
      const missing: string[] = [];
      if (!apiKey) missing.push("WORKOS_API_KEY");
      if (!clientId) missing.push("WORKOS_CLIENT_ID");
      if (missing.length > 0) {
        throw new Error(
          `AUTH_PROVIDER=workos requires the following env vars to be set: ${missing.join(", ")}. ` +
            "Set them in your .env file or environment before starting the server.",
        );
      }
      return createWorkOSProvider({ apiKey: apiKey!, clientId: clientId! });
    }

    default: {
      // TypeScript exhaustiveness check — should never reach here at runtime.
      const _exhaustive: never = authProvider;
      throw new Error(`Unknown AUTH_PROVIDER value: ${String(_exhaustive)}`);
    }
  }
}
