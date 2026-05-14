// Closes #225: heartbeatDigest now renders a proper email body — greeting,
// context line ("While you were away, your team did N things"), grouped
// per-agent section, and an "Open in AgentDash" CTA. The old renderer
// collapsed everything into one-line `agentName: summary` slop, which
// gave no clear next action and failed the spec's value-prop test.

interface Activity {
  agentName: string;
  summary: string;
}

interface DigestUser {
  id: string;
  email: string;
  // Closes #225: optional display name for the greeting. Adapter pulls
  // this from authUsers.name; falls back to the email local-part below.
  name?: string | null;
  timezone?: string;
}

interface Deps {
  email: { send: (msg: { to: string; subject: string; body: string }) => Promise<void> };
  activity: { listSince: (userId: string, sinceHours: number) => Promise<Activity[]> };
  users: { listForDigest: () => Promise<DigestUser[]> };
  // Closes #225: public origin used to build the "Open in AgentDash"
  // deep link. When omitted, the CTA renders as a plain "/cos" path —
  // most mail clients still resolve relative paths against the originating
  // domain in HTML emails, but absolute is preferred. Wire from
  // process.env.AGENTDASH_PUBLIC_BASE_URL at the caller.
  publicBaseUrl?: string;
}

export function heartbeatDigest(deps: Deps) {
  return {
    run: async () => {
      const users = await deps.users.listForDigest();
      for (const user of users) {
        const activity = await deps.activity.listSince(user.id, 24);
        if (activity.length === 0) continue;
        const subject = renderSubject(activity);
        const body = renderBody(user, activity, deps.publicBaseUrl);
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

// Closes #225: per onboarding spec §5 the digest body should feel
// person-written, point at the most useful next click, and never leave
// the reader wondering what to do. Structure:
//
//   Hi {firstName},
//
//   While you were away, your team did {N} thing{s}:
//
//     • {agentName}: {summary}
//     • ...
//
//   Open in AgentDash → {publicBaseUrl}/cos
//
// `firstName` falls back to the email local-part (before "@") when no
// authUsers.name is available, so we never address a digest as "Hi ,".
function renderBody(user: DigestUser, activity: Activity[], publicBaseUrl?: string): string {
  const firstName = pickFirstName(user);
  const count = activity.length;
  const ctaUrl = `${publicBaseUrl ?? ""}/cos`;
  const lines: string[] = [];
  lines.push(`Hi ${firstName},`);
  lines.push("");
  lines.push(
    `While you were away, your team did ${count} thing${count === 1 ? "" : "s"}:`,
  );
  lines.push("");
  for (const a of activity) {
    lines.push(`  • ${a.agentName}: ${a.summary}`);
  }
  lines.push("");
  lines.push(`Open in AgentDash → ${ctaUrl}`);
  return lines.join("\n");
}

function pickFirstName(user: DigestUser): string {
  const name = (user.name ?? "").trim();
  if (name) return name.split(/\s+/)[0]!;
  const local = (user.email ?? "").split("@")[0] ?? "";
  if (local) {
    // "ada.lovelace" → "Ada", "ada_lovelace" → "Ada", "ada-lovelace" → "Ada"
    const first = local.split(/[._-]/)[0] ?? local;
    return first.charAt(0).toUpperCase() + first.slice(1);
  }
  return "there";
}
