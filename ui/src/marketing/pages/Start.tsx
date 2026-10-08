/**
 * AgentDash (SC-7, GH #768): /start — sign up for a hosted workspace.
 * Email, workspace name (its slug is checked live), Turnstile when
 * configured, terms. The control plane mails a single-use link; nothing is
 * created until it is used (spec §1 steps 2 and 3).
 */
import "./Start.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { Button } from "../components/Button";
import { Turnstile } from "../cloud/Turnstile";
import { cloudApi, CloudApiError, type CloudConfig, SLUG_RE, slugify } from "../cloud/api";
import { useDocumentMeta } from "../hooks/useDocumentMeta";

type SlugState = { kind: "idle" } | { kind: "checking" } | { kind: "ok" } | { kind: "bad"; message: string };

export function Start() {
  useDocumentMeta(
    "Create your AgentDash workspace",
    "Your own AgentDash workspace at your-name.agentdash.cloud, with a Chief of Staff agent ready to interview you.",
  );
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugState, setSlugState] = useState<SlugState>({ kind: "idle" });
  const [terms, setTerms] = useState(false);
  const [invitationCode, setInvitationCode] = useState("");
  const submitPending = useRef(false);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState<"idle" | "sending" | "sent" | string>("idle");
  const checkSeq = useRef(0);

  useEffect(() => {
    cloudApi.config().then(setConfig, (e: unknown) => setConfigError(e instanceof CloudApiError ? e.message : "Signup is not available right now."));
  }, []);

  useEffect(() => {
    if (!slugEdited) setSlug(slugify(name));
  }, [name, slugEdited]);

  // Live availability check, debounced; a stale answer never overwrites a newer one.
  useEffect(() => {
    if (!slug) {
      setSlugState({ kind: "idle" });
      return;
    }
    if (!SLUG_RE.test(slug)) {
      setSlugState({ kind: "bad", message: "Use 3 to 16 lowercase letters, numbers or dashes, starting with a letter." });
      return;
    }
    const seq = ++checkSeq.current;
    setSlugState({ kind: "checking" });
    const t = setTimeout(() => {
      cloudApi.slugAvailable(slug).then(
        (r) => {
          if (seq !== checkSeq.current) return;
          setSlugState(r.available ? { kind: "ok" } : { kind: "bad", message: r.message ?? "That name is not available." });
        },
        () => seq === checkSeq.current && setSlugState({ kind: "idle" }),
      );
    }, 350);
    return () => clearTimeout(t);
  }, [slug]);

  const needsToken = Boolean(config?.turnstileSiteKey);
  const canSubmit =
    !submitting && Boolean(config?.signupOpen) && email.includes("@") && name.trim().length >= 2 && slugState.kind !== "bad" && SLUG_RE.test(slug) && terms && (!needsToken || Boolean(token));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || submitPending.current) return;
    submitPending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await cloudApi.signup({ email: email.trim(), workspaceName: name.trim(), slug, acceptTerms: terms, turnstileToken: token ?? undefined, ...(config?.invitationCodesEnabled === true && invitationCode.trim() ? { invitationCode: invitationCode.trim() } : {}) });
      setInvitationCode("");
      setSentTo(email.trim());
    } catch (err) {
      setError(err instanceof CloudApiError ? err.message : "Something went wrong. Try again.");
      if (err instanceof CloudApiError && err.code.startsWith("slug_")) setSlugState({ kind: "bad", message: err.message });
      setResetKey((k) => k + 1);
    } finally {
      submitPending.current = false;
      setSubmitting(false);
    }
  }

  async function onResend() {
    if (!sentTo) return;
    setResent("sending");
    try {
      await cloudApi.resend(sentTo);
      setResent("sent");
    } catch (err) {
      setResent(err instanceof CloudApiError ? err.message : "Could not re-send. Try again in a minute.");
    }
  }

  return (
    <MarketingShell>
      <SectionContainer padding="hero">
        <div className="mkt-cloud">
          <div className="mkt-cloud__intro">
            <Eyebrow>AgentDash Cloud</Eyebrow>
            <h1 className="mkt-display-page">Create your workspace.</h1>
            <p className="mkt-body-lg">
              Your own AgentDash at <strong>{slug || "your-name"}.{config?.edgeDomain ?? "agentdash.cloud"}</strong>, with a Chief of Staff
              agent ready to interview you. Once admitted and capacity is available, setup usually takes about three minutes.
            </p>
            {(config?.waitlist || config?.invitationCodesEnabled === true) && (
              <p className="mkt-cloud__note" data-testid="waitlist-note">
                {config?.invitationCodesEnabled === true ? "Without a code, sign up and verify your email to join the waitlist. An invitation code admits one workspace after email verification, subject to available capacity. We will email you when your workspace is being created." : "We are letting people in a few at a time. Sign up to save your name and your place; we will email you when your workspace is being created."}
              </p>
            )}
          </div>

          <div className="mkt-cloud__card">
            {sentTo ? (
              <div className="mkt-cloud__done" data-testid="check-email">
                <h2>Check your email</h2>
                <p>
                  We sent a link to <strong>{sentTo}</strong>. Open it on this device within 30 minutes to confirm your address. The link works once.
                </p>
                <p className="mkt-cloud__muted">
                  Nothing there?{" "}
                  <button type="button" className="mkt-cloud__linkbtn" onClick={onResend} disabled={resent === "sending" || resent === "sent"}>
                    {resent === "sent" ? "Sent again" : "Send it again"}
                  </button>
                  {resent !== "idle" && resent !== "sending" && resent !== "sent" && <span className="mkt-cloud__error"> {resent}</span>}
                </p>
              </div>
            ) : (
              <form onSubmit={onSubmit} noValidate data-testid="start-form">
                {configError && <p className="mkt-cloud__error" role="alert">{configError}</p>}
                {config && !config.signupOpen && (
                  <p className="mkt-cloud__error" role="alert">Signup is not open yet. Check back soon.</p>
                )}
                <label className="mkt-cloud__field">
                  <span>Work email</span>
                  <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
                </label>
                <label className="mkt-cloud__field">
                  <span>Workspace name</span>
                  <input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Robotics" maxLength={80} />
                </label>
                <label className="mkt-cloud__field">
                  <span>Web address</span>
                  <div className="mkt-cloud__slug">
                    <input
                      type="text"
                      value={slug}
                      onChange={(e) => {
                        setSlugEdited(true);
                        setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                      }}
                      aria-describedby="slug-status"
                      maxLength={16}
                      spellCheck={false}
                      autoCapitalize="off"
                    />
                    <span className="mkt-cloud__suffix">.{config?.edgeDomain ?? "agentdash.cloud"}</span>
                  </div>
                  <small id="slug-status" data-testid="slug-status" className={slugState.kind === "bad" ? "mkt-cloud__error" : slugState.kind === "ok" ? "mkt-cloud__ok" : "mkt-cloud__muted"}>
                    {slugState.kind === "checking" && "Checking…"}
                    {slugState.kind === "ok" && "Available"}
                    {slugState.kind === "bad" && slugState.message}
                    {slugState.kind === "idle" && "Letters, numbers and dashes. You cannot change it later."}
                  </small>
                </label>
                {config?.invitationCodesEnabled === true && (
                  <label className="mkt-cloud__field">
                    <span>Invitation code (optional)</span>
                    <input
                      type="text"
                      value={invitationCode}
                      onChange={(e) => setInvitationCode(e.target.value)}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      maxLength={120}
                      disabled={submitting}
                      aria-describedby="invitation-help"
                    />
                    <small id="invitation-help" className="mkt-cloud__muted">Leave this blank to join the waitlist.</small>
                  </label>
                )}
                {config?.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setToken} resetKey={resetKey} />}
                <label className="mkt-cloud__check">
                  <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
                  <span>
                    I agree to the <a href="/terms" target="_blank" rel="noreferrer">terms</a> and the{" "}
                    <a href="/privacy" target="_blank" rel="noreferrer">privacy policy</a>.
                  </span>
                </label>
                {error && <p className="mkt-cloud__error" role="alert" data-testid="start-error">{error}</p>}
                <Button type="submit" disabled={!canSubmit} className="mkt-cloud__submit">
                  {submitting ? "Sending…" : "Email me a link"}
                </Button>
                <p className="mkt-cloud__muted mkt-cloud__center">
                  Already have a workspace? <a href="/find">Find it</a>
                </p>
              </form>
            )}
          </div>
        </div>
      </SectionContainer>
    </MarketingShell>
  );
}
