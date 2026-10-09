import { api } from "./client";

/**
 * AgentDash (per-steward document access, slice 7): the signed-in person's
 * own document-provider connection. Microsoft 365 only in v1.
 *
 * Every route binds to the session: there is no user id parameter, and no
 * response carries an access token, refresh token, code or verifier. The
 * routes answer 404 while the company's `document_access_enabled` flag is off.
 */

/** `read` reads; `read_propose` also lets an approved agent add new files to your OneDrive. */
export type DocumentConnectionTier = "read" | "read_propose";

export interface DocumentConnectionView {
  id: string;
  /** The Microsoft sign-in name (UPN) the connection belongs to. */
  account: string | null;
  scopes: string[];
  writeScopes: string[];
  /** Null while a sign-in has started but not finished. */
  tier: DocumentConnectionTier | null;
  status: "pending" | "active" | "expired" | "error";
  lastError: { reason: string; message: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentConnectionHealth {
  /** False when this instance has no Microsoft sign-in configured at all. */
  configured: boolean;
  connection: DocumentConnectionView | null;
}

export interface DocumentConnectCallbackInput {
  /** Exactly one of `code` (signed in) or `error` (declined at Microsoft). */
  code?: string;
  error?: string;
  state: string;
  redirectUri: string;
}

export const documentsApi = {
  getMicrosoft: (companyId: string) =>
    api.get<DocumentConnectionHealth>(`/companies/${companyId}/me/connections/microsoft`),
  initiateMicrosoft: (companyId: string, input: { redirectUri: string; tier: DocumentConnectionTier }) =>
    api.post<{ authorizationUrl: string; connectionId: string }>(
      `/companies/${companyId}/me/connections/microsoft/oauth/initiate`,
      input,
    ),
  completeMicrosoft: (companyId: string, input: DocumentConnectCallbackInput) =>
    api.post<{ connection: DocumentConnectionView }>(
      `/companies/${companyId}/me/connections/microsoft/oauth/callback`,
      input,
    ),
  revokeMicrosoft: (companyId: string) =>
    api.post<{ connectionId: string; revoked: boolean }>(
      `/companies/${companyId}/me/connections/microsoft/revoke`,
      {},
    ),
};
