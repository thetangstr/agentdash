/**
 * AgentDash (SC-7, GH #768): /start/progress — "Creating your workspace".
 * Polls GET /api/cloud/boxes/mine: the waitlist message while queued, the
 * provisioning steps while the job runs, and the Open my workspace button
 * (the one-time claim link) when it is ready (spec §1 steps 4 and 5).
 */
import "./Start.css";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { Button } from "../components/Button";
import { type BoxView, cloudApi, CloudApiError, type MyBoxes } from "../cloud/api";
import { useDocumentMeta } from "../hooks/useDocumentMeta";

export const PROGRESS_STEPS = [
  "Reserving your address",
  "Setting up your database",
  "Configuring your workspace",
  "Starting it up",
  "Checking it is healthy",
] as const;

/** How often to ask again: fast while something is happening, slow while waiting on the list. */
export function pollDelay(box: BoxView | undefined): number | null {
  if (!box) return 15_000;
  if (box.phase === "provisioning") return 4_000;
  if (box.phase === "waitlisted" || box.phase === "approved") return 30_000;
  return null;
}

export function StartProgress() {
  useDocumentMeta("Your AgentDash workspace", "Progress on your AgentDash workspace.");
  const [data, setData] = useState<MyBoxes | null>(null);
  const [error, setError] = useState<CloudApiError | null>(null);
  const [invitationEnabled, setInvitationEnabled] = useState(false);
  const [invitationConfigError, setInvitationConfigError] = useState<string | null>(null);
  const [loadingInvitationConfig, setLoadingInvitationConfig] = useState(false);
  const invitationConfigPending = useRef(false);
  const [invitationCode, setInvitationCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [invitationAccepted, setInvitationAccepted] = useState(false);
  const redeemPending = useRef(false);
  const [resent, setResent] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await cloudApi.mine());
      setError(null);
    } catch (err) {
      setError(err instanceof CloudApiError ? err : new CloudApiError("Something went wrong.", 0, "unknown"));
    }
  }, []);

  const loadInvitationConfig = useCallback(async () => {
    if (invitationConfigPending.current) return;
    invitationConfigPending.current = true;
    setLoadingInvitationConfig(true);
    try {
      const config = await cloudApi.config();
      setInvitationEnabled(config.invitationCodesEnabled === true);
      setInvitationConfigError(null);
    } catch (err) {
      setInvitationEnabled(false);
      setInvitationConfigError(err instanceof CloudApiError ? err.message : "Could not load invitation options. Try again.");
    } finally {
      invitationConfigPending.current = false;
      setLoadingInvitationConfig(false);
    }
  }, []);

  useEffect(() => {
    void loadInvitationConfig();
  }, [loadInvitationConfig]);

  const box = data?.boxes[0];
  useEffect(() => {
    if (!data && !error) {
      void load();
      return;
    }
    if (error?.code === "no_session") return;
    const delay = error ? 15_000 : pollDelay(box);
    if (delay === null) return;
    const t = setTimeout(() => void load(), delay);
    return () => clearTimeout(t);
  }, [data, error, box, load]);

  async function onRedeem(e: FormEvent) {
    e.preventDefault();
    const code = invitationCode.trim();
    if (!code || redeemPending.current || !invitationEnabled || error || box?.phase !== "waitlisted") return;
    redeemPending.current = true;
    setRedeeming(true);
    setInvitationError(null);
    try {
      await cloudApi.redeemInvitation(code);
      setInvitationCode("");
      setInvitationAccepted(true);
      await load();
    } catch (err) {
      if (err instanceof CloudApiError && err.code === "no_session") {
        setInvitationCode("");
        setError(err);
      } else {
        setInvitationError(err instanceof CloudApiError ? err.message : "Could not apply this invitation. Try again.");
      }
    } finally {
      redeemPending.current = false;
      setRedeeming(false);
    }
  }

  async function onResend() {
    try {
      await cloudApi.resend();
      setResent("We emailed the link again.");
    } catch (err) {
      setResent(err instanceof CloudApiError ? err.message : "Could not re-send. Try again in a minute.");
    }
  }

  return (
    <MarketingShell>
      <SectionContainer padding="hero">
        <div className="mkt-cloud mkt-cloud--narrow">
          <Eyebrow>AgentDash Cloud</Eyebrow>
          <div className="mkt-cloud__card" data-testid="progress-card">
            {error?.code === "no_session" ? (
              <>
                <h2>Sign in to see your workspace</h2>
                <p>Your session on this page has ended. We can email you a fresh link.</p>
                <div className="mkt-cloud__actions">
                  <Button href="/find">Email me a link</Button>
                </div>
              </>
            ) : !data ? (
              <>
                <h2>Loading…</h2>
                {error && <p className="mkt-cloud__error" role="alert">{error.message}</p>}
              </>
            ) : !box ? (
              <>
                <h2>No workspace yet</h2>
                <p>{data.email} does not have a workspace.</p>
                <div className="mkt-cloud__actions">
                  <Button href="/start">Create one</Button>
                </div>
              </>
            ) : (
              <>
                {error && <p className="mkt-cloud__error" role="alert">{error.message}</p>}
                {invitationAccepted && <p className="mkt-cloud__ok" role="status">Your invitation is accepted. We will email you when your workspace is ready; creation depends on available capacity.</p>}
                <BoxStatus box={box} email={data.email} onResend={onResend} resent={resent} />
                {box.phase === "waitlisted" && !error && invitationConfigError && (
                  <div>
                    <p className="mkt-cloud__error" role="alert">Invitation options could not load. {invitationConfigError}</p>
                    <button type="button" className="mkt-cloud__linkbtn" disabled={loadingInvitationConfig} onClick={() => void loadInvitationConfig()}>
                      {loadingInvitationConfig ? "Loading invitation options…" : "Retry invitation options"}
                    </button>
                  </div>
                )}
                {box.phase === "waitlisted" && invitationEnabled && !error && (
                  <form onSubmit={onRedeem} noValidate data-testid="invitation-form" aria-busy={redeeming}>
                    <label className="mkt-cloud__field">
                      <span>Invitation code</span>
                      <input
                        type="text"
                        value={invitationCode}
                        onChange={(e) => setInvitationCode(e.target.value)}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        maxLength={120}
                        disabled={redeeming}
                        aria-describedby="redeem-help"
                      />
                      <small id="redeem-help" className="mkt-cloud__muted">Have an invitation? Apply it to this verified workspace. Creation still depends on available capacity.</small>
                    </label>
                    {invitationError && <p className="mkt-cloud__error" role="alert">{invitationError}</p>}
                    <Button type="submit" disabled={redeeming || !invitationCode.trim()} className="mkt-cloud__submit">
                      {redeeming ? "Applying…" : "Apply invitation"}
                    </Button>
                  </form>
                )}
              </>
            )}
          </div>
        </div>
      </SectionContainer>
    </MarketingShell>
  );
}

function BoxStatus({ box, email, onResend, resent }: { box: BoxView; email: string; onResend: () => void; resent: string | null }) {
  const host = box.url.replace(/^https:\/\//, "");
  switch (box.phase) {
    case "waitlisted":
      return (
        <div data-testid="phase-waitlisted">
          <h2>You're on the list</h2>
          <p>
            Your address <strong>{host}</strong> is saved for you. We are letting people in a few at a time and will email <strong>{email}</strong> as soon as your workspace is being created.
          </p>
          <p className="mkt-cloud__muted">You can close this page.</p>
        </div>
      );
    case "approved":
      return (
        <div data-testid="phase-approved">
          <h2>You're in</h2>
          <p>
            You are approved for <strong>{host}</strong>. We will create your workspace when capacity is available, then email <strong>{email}</strong> the link to open it when it is ready.
          </p>
          <p className="mkt-cloud__muted">You can close this page.</p>
        </div>
      );
    case "provisioning":
      return (
        <div data-testid="phase-provisioning">
          <h2>Creating your workspace</h2>
          <p>
            Setting up <strong>{host}</strong>. This usually takes about three minutes.
          </p>
          <ol className="mkt-cloud__steps">
            {PROGRESS_STEPS.map((label, i) => {
              const at = box.stepIndex ?? 0;
              const state = i < at ? "done" : i === at ? "now" : "todo";
              return (
                <li key={label} className={`mkt-cloud__step is-${state}`} aria-current={state === "now" ? "step" : undefined}>
                  {label}
                </li>
              );
            })}
          </ol>
          {box.slow && (
            <p className="mkt-cloud__note" data-testid="slow-note">
              This is taking longer than usual. You can close this page: we will email {email} the moment it is ready.
            </p>
          )}
        </div>
      );
    case "ready":
      return (
        <div data-testid="phase-ready">
          <h2>Your workspace is ready</h2>
          <p>
            Open <strong>{host}</strong> to create your account. The link is only for you: it works once, for {email}, and we also emailed it to you.
          </p>
          <div className="mkt-cloud__actions">
            {box.claimUrl ? <Button href={box.claimUrl}>Open my workspace</Button> : <Button href={box.url}>Open my workspace</Button>}
          </div>
          <p className="mkt-cloud__muted">
            Lost the email?{" "}
            <button type="button" className="mkt-cloud__linkbtn" onClick={onResend}>
              Send the link again
            </button>
            {resent && <span> {resent}</span>}
          </p>
        </div>
      );
    case "active":
    case "suspended":
      return (
        <div data-testid="phase-active">
          <h2>{box.phase === "suspended" ? "Your workspace is paused" : "Your workspace is live"}</h2>
          <p>
            {box.phase === "suspended" ? "Visiting it wakes it up in about a minute." : "Sign in there with the account you created."}
          </p>
          <div className="mkt-cloud__actions">
            <Button href={box.url}>Go to {host}</Button>
          </div>
        </div>
      );
    case "failed":
      return (
        <div data-testid="phase-failed">
          <h2>We hit a problem</h2>
          <p>
            Setting up <strong>{host}</strong> did not finish. We have been alerted and are on it; your address is kept. We will email {email} when it is ready.
          </p>
        </div>
      );
    default:
      return (
        <div data-testid="phase-closing">
          <h2>This workspace is being closed</h2>
          <p>Write to us if you did not expect this.</p>
        </div>
      );
  }
}
