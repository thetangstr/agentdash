/**
 * AgentDash (SC-7, GH #768): /find — returning users. Email in, links to
 * that email's workspaces mailed out. The answer is the same whether or not
 * the address has a workspace.
 */
import "./Start.css";
import { useEffect, useState, type FormEvent } from "react";
import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { Button } from "../components/Button";
import { Turnstile } from "../cloud/Turnstile";
import { cloudApi, CloudApiError, type CloudConfig } from "../cloud/api";
import { useDocumentMeta } from "../hooks/useDocumentMeta";

export function Find() {
  useDocumentMeta("Find your AgentDash workspace", "Get a link to your AgentDash workspace by email.");
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    cloudApi.config().then(setConfig, () => setConfig(null));
  }, []);

  const needsToken = Boolean(config?.turnstileSiteKey);
  const canSubmit = !submitting && email.includes("@") && (!needsToken || Boolean(token));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await cloudApi.find({ email: email.trim(), turnstileToken: token ?? undefined });
      setSentTo(email.trim());
    } catch (err) {
      setError(err instanceof CloudApiError ? err.message : "Something went wrong. Try again.");
      setResetKey((k) => k + 1);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <MarketingShell>
      <SectionContainer padding="hero">
        <div className="mkt-cloud mkt-cloud--narrow">
          <Eyebrow>AgentDash Cloud</Eyebrow>
          <h1 className="mkt-display-page">Find your workspace.</h1>
          <div className="mkt-cloud__card">
            {sentTo ? (
              <div data-testid="find-sent">
                <h2>Check your email</h2>
                <p>
                  If <strong>{sentTo}</strong> has an AgentDash workspace, we have emailed a link to it. The link works once and expires in 30 minutes.
                </p>
                <p className="mkt-cloud__muted">
                  No workspace yet? <a href="/start">Create one</a>
                </p>
              </div>
            ) : (
              <form onSubmit={onSubmit} noValidate data-testid="find-form">
                <label className="mkt-cloud__field">
                  <span>The email you signed up with</span>
                  <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
                </label>
                {config?.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setToken} resetKey={resetKey} />}
                {error && <p className="mkt-cloud__error" role="alert">{error}</p>}
                <Button type="submit" disabled={!canSubmit} className="mkt-cloud__submit">
                  {submitting ? "Sending…" : "Email me a link"}
                </Button>
                <p className="mkt-cloud__muted mkt-cloud__center">
                  Running AgentDash yourself? Sign in on your own install.
                </p>
              </form>
            )}
          </div>
        </div>
      </SectionContainer>
    </MarketingShell>
  );
}
