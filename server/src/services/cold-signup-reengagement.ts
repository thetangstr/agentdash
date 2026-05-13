// Cold-start re-engagement email for users who signed up but never opened
// the chat panel. Per onboarding spec §7, sends a one-time "your CoS is
// waiting" email after 7 days of inactivity. Runs on the same daily tick as
// the heartbeat digest to keep cron count low.

export interface ColdSignupUser {
  id: string;
  email: string;
  createdAt: Date;
}

export interface Deps {
  /** Fetch cold-signup users eligible for the one-time email. */
  users: { listEligible: () => Promise<ColdSignupUser[]> };
  /** Check whether a user has already received this email; record a send. */
  sent: {
    hasReceived: (userId: string) => Promise<boolean>;
    markSent: (userId: string) => Promise<void>;
  };
  /** Send the email. */
  email: { send: (msg: { to: string; subject: string; html: string }) => Promise<void> };
}

export function coldSignupReengagement(deps: Deps) {
  return {
    /**
     * Scan all cold-signup users and send the one-time email to any that
     * haven't received it yet. Safe to call on every daily tick — the
     * `sent.hasReceived` guard ensures at most one email per user.
     */
    run: async () => {
      const users = await deps.users.listEligible();
      for (const user of users) {
        const alreadySent = await deps.sent.hasReceived(user.id);
        if (alreadySent) continue;

        const subject = "Your Chief of Staff is waiting for you";
        const body = renderBody(user);
        await deps.email.send({ to: user.email, subject, html: body });
        await deps.sent.markSent(user.id);
      }
    },
  };
}

function renderBody(user: ColdSignupUser): string {
  const name = user.email.split("@")[0];
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px;">
  <h2>Hi ${name},</h2>
  <p>You created an AgentDash account a little while back — we noticed you haven't
  opened the chat panel yet, so your Chief of Staff is just checking in.</p>
  <p>Your CoS is ready to help you stay on top of things — from summoning agents
  to running deep-dive interviews on any topic you care about.</p>
  <p style="margin: 24px 0;"><a href="${process.env.AGENTDASH_APP_URL ?? "https://app.agentdash.io"}"
     style="background: #4f46e5; color: #fff; padding: 10px 20px;
            border-radius: 6px; text-decoration: none; font-weight: 600;">
     Open AgentDash
  </a></p>
  <p style="color: #6b7280; font-size: 13px;">If you no longer want to receive
  emails from us, you can disable notifications in your account settings.</p>
</body>
</html>`;
}
