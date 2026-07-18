// AgentDash (Test Drive): shared, read-only rendering of a trial outreach
// artifact. Used by the live /trial experience (TrialLanding) and the PUBLIC
// /share/:shareToken view (SharedArtifact). Porcelain-native, no credit meter,
// no edit — just the deliverable (angle + touches + tips).

import { Linkedin, Mail, Lightbulb } from "lucide-react";
import type { TrialArtifact, TrialOutreachContent } from "../../api/trial";

export function channelIcon(channel: string) {
  const c = channel.toLowerCase();
  if (c.includes("linkedin")) return <Linkedin className="size-3.5" />;
  return <Mail className="size-3.5" />;
}

/** Flatten an artifact to plain text for the clipboard. */
export function buildPlainText(artifact: TrialArtifact): string {
  const { title, content } = artifact;
  const lines: string[] = [title, "", content.summary, ""];
  for (const touch of content.touches) {
    lines.push(`— Day ${touch.day} · ${touch.channel} —`);
    if (touch.subject) lines.push(`Subject: ${touch.subject}`);
    lines.push(touch.body, "");
  }
  if (content.tips.length > 0) {
    lines.push("Tips:");
    for (const tip of content.tips) lines.push(`• ${tip}`);
  }
  return lines.join("\n").trim();
}

function TouchCard({ touch }: { touch: TrialOutreachContent["touches"][number] }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-50,rgba(0,0,0,0.04))] px-2.5 py-1 text-xs font-medium text-[var(--accent-600,var(--accent-500))]">
        {channelIcon(touch.channel)}
        Day {touch.day} · {touch.channel}
      </span>
      {touch.subject ? (
        <p className="mt-3 font-semibold text-foreground">{touch.subject}</p>
      ) : null}
      <p className="mt-2 whitespace-pre-line text-sm leading-6 text-foreground">{touch.body}</p>
    </div>
  );
}

/** The artifact body — angle, the touch sequence, and pre-send tips. */
export function ArtifactView({ content }: { content: TrialOutreachContent }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-5">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          the angle
        </p>
        <p className="mt-2 text-sm leading-6 text-foreground">{content.summary}</p>
      </div>

      <div className="space-y-4">
        {content.touches.map((touch, i) => (
          <TouchCard key={i} touch={touch} />
        ))}
      </div>

      {content.tips.length > 0 ? (
        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            <Lightbulb className="size-3.5 text-[var(--accent-500)]" />
            tips before you send
          </p>
          <ul className="mt-3 space-y-2">
            {content.tips.map((tip, i) => (
              <li key={i} className="flex gap-2 text-sm leading-6 text-muted-foreground">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--accent-500)]" />
                {tip}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
