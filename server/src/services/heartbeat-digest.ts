interface Activity {
  agentName: string;
  summary: string;
}

interface DigestUser {
  id: string;
  email: string;
  timezone?: string;
}

interface Deps {
  email: { send: (msg: { to: string; subject: string; body: string }) => Promise<void> };
  activity: { listSince: (userId: string, sinceHours: number) => Promise<Activity[]> };
  users: { listForDigest: () => Promise<DigestUser[]> };
}

export function heartbeatDigest(deps: Deps) {
  return {
    run: async () => {
      const users = await deps.users.listForDigest();
      for (const user of users) {
        const activity = await deps.activity.listSince(user.id, 24);
        if (activity.length === 0) continue;
        const subject = renderSubject(activity);
        const body = renderBody(activity);
        await deps.email.send({ to: user.email, subject, body });
      }
    },
  };
}

function renderSubject(activity: Activity[]): string {
  if (activity.length === 0) return "Your AgentDash digest";
  const first = activity[0];
  const more =
    activity.length > 1
      ? ` and ${activity.length - 1} more update${activity.length === 2 ? "" : "s"}`
      : "";
  return `${first.agentName}: ${first.summary}${more}`;
}

function renderBody(activity: Activity[]): string {
  return activity.map((a) => `${a.agentName}: ${a.summary}`).join("\n");
}
