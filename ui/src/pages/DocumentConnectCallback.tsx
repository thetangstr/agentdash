import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { documentsApi } from "../api/documents";
import { useCompany } from "../context/CompanyContext";
import {
  clearPendingConnect,
  documentRedirectUri,
  isDocumentConnectProvider,
  readCallbackParams,
  readPendingConnect,
  safeReturnTo,
  type DocumentCallbackParams,
} from "../lib/document-connect";
import { queryKeys } from "../lib/queryKeys";

/**
 * AgentDash (per-steward document access, slice 7): where Microsoft sends the
 * browser back after the person signs in, `/connect/:provider/callback`.
 *
 * The query string carries a one-time authorization code. This page reads it
 * once, replaces the address with the bare path before doing anything else
 * (so the code is not left in the address bar or in history), posts
 * `{code, state, redirectUri}` to the server, and goes back to My Agent.
 *
 * The post is a plain call, not a React Query mutation or query, so the code
 * never sits in the query or mutation cache either. A ref keeps it to one post
 * even when StrictMode runs effects twice: the server's state is single-use,
 * and a second post would turn a successful sign-in into an error.
 */

type Phase =
  | { kind: "working" }
  | { kind: "failed"; message: string };

const DEFAULT_RETURN_TO = "/my-agent";

export default function DocumentConnectCallback() {
  const { provider } = useParams<{ provider: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedCompanyId, loading: companiesLoading } = useCompany();

  // Read once, on the first render: the address is cleaned right after.
  const [params] = useState<DocumentCallbackParams>(() => readCallbackParams(location.search));
  const [phase, setPhase] = useState<Phase>({ kind: "working" });
  const [returnTo, setReturnTo] = useState(DEFAULT_RETURN_TO);
  const started = useRef(false);

  // Strip the code and state from the address at once, whatever happens next.
  useEffect(() => {
    if (location.search) navigate(location.pathname, { replace: true });
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    if (started.current) return;
    if (!isDocumentConnectProvider(provider)) {
      started.current = true;
      setPhase({ kind: "failed", message: `"${provider ?? ""}" is not a document provider AgentDash can connect.` });
      return;
    }
    const pending = readPendingConnect(provider);
    // Without a remembered sign-in, wait for the selected company before deciding.
    if (!pending && companiesLoading) return;
    started.current = true;

    const companyId = pending?.companyId ?? selectedCompanyId ?? null;
    const target = pending?.returnTo ?? DEFAULT_RETURN_TO;
    setReturnTo(target);
    clearPendingConnect();

    if (!params.state || (!params.code && !params.error)) {
      setPhase({
        kind: "failed",
        message: "This sign-in link is incomplete, so nothing was connected. Start again from My Agent.",
      });
      return;
    }
    if (!companyId) {
      setPhase({
        kind: "failed",
        message: "Could not tell which workspace this sign-in was for. Start again from My Agent.",
      });
      return;
    }

    const redirectUri = pending?.redirectUri ?? documentRedirectUri(provider, window.location.origin);
    const body = params.code
      ? { code: params.code, state: params.state, redirectUri }
      : { error: params.error!, state: params.state, redirectUri };

    void documentsApi
      .completeMicrosoft(companyId, body)
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.myAgent.documents(companyId, provider) });
        navigate(safeReturnTo(target), { replace: true });
      })
      .catch((error: unknown) => {
        setPhase({
          kind: "failed",
          message:
            error instanceof Error && error.message
              ? error.message
              : "Microsoft did not finish connecting. Start again from My Agent.",
        });
      });
  }, [provider, params, companiesLoading, selectedCompanyId, queryClient, navigate]);

  if (phase.kind === "working") {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 text-sm text-muted-foreground" role="status">
        Finishing your Microsoft 365 connection…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-lg font-semibold">Microsoft 365 was not connected</h1>
      <p className="mt-2 text-sm text-destructive" role="alert">
        {phase.message}
      </p>
      <Link to={safeReturnTo(returnTo)} className="mt-4 inline-block text-sm underline">
        Back to My Agent
      </Link>
    </div>
  );
}
