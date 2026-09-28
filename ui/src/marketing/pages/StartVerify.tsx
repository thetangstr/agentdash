/**
 * AgentDash (SC-7, GH #768): /start/verify — where a magic link lands.
 * The token rides in the URL fragment (never sent to a server by the
 * browser, never in a referrer); this page posts it once, removes it from the
 * address bar, and moves on to the progress page.
 */
import "./Start.css";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Button } from "../components/Button";
import { cloudApi, CloudApiError } from "../cloud/api";
import { useDocumentMeta } from "../hooks/useDocumentMeta";

export function readFragmentToken(hash: string): string | null {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{20,100})(?:&|$)/.exec(hash);
  return m ? m[1]! : null;
}

export function StartVerify() {
  useDocumentMeta("Confirming your email · AgentDash", "Confirming your email address.");
  const navigate = useNavigate();
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = readFragmentToken(window.location.hash);
    // Drop the token from the address bar and history either way.
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setError({ message: "This link is incomplete. Open the whole link from your email.", code: "link_invalid" });
      return;
    }
    cloudApi.verify(token).then(
      () => navigate("/start/progress", { replace: true }),
      (err: unknown) =>
        setError(err instanceof CloudApiError ? { message: err.message, code: err.code } : { message: "Something went wrong. Try the link again.", code: "unknown" }),
    );
  }, [navigate]);

  return (
    <MarketingShell>
      <SectionContainer padding="hero">
        <div className="mkt-cloud mkt-cloud--narrow">
          <div className="mkt-cloud__card" data-testid="verify-card">
            {error ? (
              <>
                <h2>That link did not work</h2>
                <p className="mkt-cloud__error" role="alert" data-testid="verify-error">{error.message}</p>
                <div className="mkt-cloud__actions">
                  {error.code === "link_used" || error.code === "slug_taken" || error.code === "ip_daily_limit" || error.code === "domain_daily_limit" ? (
                    <>
                      <Button href="/find">Find my workspace</Button>
                      <Button href="/start" variant="ghost">Start again</Button>
                    </>
                  ) : (
                    <>
                      <Button href="/start">Start again</Button>
                      <Button href="/find" variant="ghost">Find my workspace</Button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <h2>Confirming your email…</h2>
                <p className="mkt-cloud__muted">One moment.</p>
              </>
            )}
          </div>
        </div>
      </SectionContainer>
    </MarketingShell>
  );
}
