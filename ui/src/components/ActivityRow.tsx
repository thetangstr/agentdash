import { Link } from "@/lib/router";
import { Identity } from "./Identity";
import { IssueReferenceActivitySummary } from "./IssueReferenceActivitySummary";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { formatActivityVerb, isSystemPlumbingActivity } from "../lib/activity-format";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "../lib/company-members";

function entityLink(entityType: string, entityId: string, name?: string | null): string | null {
  switch (entityType) {
    case "issue": return `/issues/${name ?? entityId}`;
    case "agent": return `/agents/${entityId}`;
    case "project": return `/projects/${deriveProjectUrlKey(name, entityId)}`;
    case "goal": return `/goals/${entityId}`;
    case "approval": return `/approvals/${entityId}`;
    default: return null;
  }
}

interface ActivityRowProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  entityNameMap: Map<string, string>;
  entityTitleMap?: Map<string, string>;
  className?: string;
  /**
   * AgentDash: mobile redesign. "inline" (default) is the one-line desktop row.
   * "stacked" is the phone row: actor + action on line one, target + time on
   * line two, nothing truncated.
   */
  layout?: "inline" | "stacked";
}

export function ActivityRow({ event, agentMap, userProfileMap, entityNameMap, entityTitleMap, className, layout = "inline" }: ActivityRowProps) {
  const verb = formatActivityVerb(event.action, event.details, { agentMap, userProfileMap });

  const isHeartbeatEvent = event.entityType === "heartbeat_run";
  const heartbeatAgentId = isHeartbeatEvent
    ? (event.details as Record<string, unknown> | null)?.agentId as string | undefined
    : undefined;

  const name =
    // AgentDash (c3 copy): the cancelled-run verb already names the agent
    // ("stopped Scout's run") — appending the entity name would repeat it.
    event.action === "heartbeat.cancelled"
      ? null
      : isHeartbeatEvent
        ? (heartbeatAgentId ? entityNameMap.get(`agent:${heartbeatAgentId}`) : null)
        : entityNameMap.get(`${event.entityType}:${event.entityId}`);

  const entityTitle = entityTitleMap?.get(`${event.entityType}:${event.entityId}`);

  const link = isHeartbeatEvent && heartbeatAgentId
    ? `/agents/${heartbeatAgentId}/runs/${event.entityId}`
    : entityLink(event.entityType, event.entityId, name);

  const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
  const userProfile = event.actorType === "user" ? userProfileMap?.get(event.actorId) : null;
  // AgentDash (review-1015): a run stopped because the issue closed is the
  // product's doing — the person only marked the issue done — so AgentDash
  // owns the row, not them.
  const statusDrivenCancel =
    event.action === "heartbeat.cancelled" &&
    typeof (event.details as Record<string, unknown> | null)?.source === "string" &&
    ((event.details as Record<string, unknown> | null)?.source as string).startsWith("issue_status_");
  const details = event.details as Record<string, unknown> | null;
  // AgentDash (c4 trust): a comment that reopens a closed issue is the
  // product reacting to the comment — the person didn't "reopen" anything.
  // `autoReopened` is set only for that implicit case; an explicit reopen
  // request still belongs to the person.
  const autoReopen = event.action === "issue.updated" && details?.autoReopened === true;
  // AgentDash (c4 trust): approvals the system opens on the person's behalf
  // (the onboarding plan's hire requests, assistant-granted actions) must not
  // read as the person asking. `via` marks an assistant-grant write; `source`
  // marks a server-originated approval such as "cos_plan".
  const systemApproval =
    (event.action === "approval.created" || event.action === "approval.resubmitted") &&
    (typeof details?.source === "string" || typeof details?.via === "string" || details?.auto === true);
  const systemEvent =
    event.actorType === "system" ||
    isSystemPlumbingActivity(event.action) ||
    statusDrivenCancel ||
    autoReopen ||
    systemApproval;
  // AgentDash (c3 copy): actions the system takes are the product's own doing —
  // "System" read like a person, so it is named "AgentDash" instead.
  const actorName = systemEvent ? "AgentDash" : actor?.name ?? ( userProfile?.label ?? (event.actorType === "user" ? "Board" : event.actorId || "Unknown"));
  const actorAvatarUrl = systemEvent ? null : userProfile?.image ?? null;

  const stacked = layout === "stacked";
  // AgentDash (c4 trust, review #1026): the added/removed chips only belong to
  // rows whose details can carry a reference diff — issue.updated and
  // issue.comment_added. Rendered unconditionally they surfaced as a stray
  // "Removed references" line under unrelated rows. They render their own
  // issue links, so they must sit OUTSIDE the row link (no nested <a>).
  const referenceSummary =
    event.action === "issue.updated" || event.action === "issue.comment_added"
      ? <IssueReferenceActivitySummary event={event} />
      : null;
  const inner = stacked ? (
    <div className="space-y-1" data-testid="activity-row-stacked">
      <p className="min-w-0 break-words">
        <Identity
          name={actorName}
          avatarUrl={actorAvatarUrl}
          size="xs"
          className="align-middle"
        />
        <span className="text-muted-foreground ml-1">{verb}</span>
      </p>
      <div className="flex items-baseline gap-3 text-xs">
        <span className="min-w-0 flex-1 break-words">
          {name && <span className="font-medium text-foreground">{name}</span>}
          {entityTitle && <span className="text-muted-foreground ml-1">— {entityTitle}</span>}
        </span>
        <span className="shrink-0 text-muted-foreground">{timeAgo(event.createdAt)}</span>
      </div>
    </div>
  ) : (
    <div className="space-y-2">
      <div className="flex gap-3">
        <p className="flex-1 min-w-0 truncate">
          <Identity
            name={actorName}
            avatarUrl={actorAvatarUrl}
            size="xs"
            className="align-middle"
          />
          <span className="text-muted-foreground ml-1">{verb} </span>
          {name && <span className="font-medium">{name}</span>}
          {entityTitle && <span className="text-muted-foreground ml-1">— {entityTitle}</span>}
        </p>
        <span className="text-xs text-muted-foreground shrink-0 pt-0.5">{timeAgo(event.createdAt)}</span>
      </div>
    </div>
  );

  const classes = cn(
    stacked ? "min-h-11 px-3 py-2.5 text-sm" : "px-4 py-2 text-sm max-sm:min-h-11",
    link && "cursor-pointer hover:bg-accent/50 transition-colors",
    className,
  );

  if (link) {
    // The row link keeps the row's padding/tap-target classes (mobile tests
    // measure them); the reference chips sit outside it with matching
    // horizontal padding, so no <a> is nested inside another.
    return (
      <div className="hover:bg-accent/50 transition-colors">
        <Link to={link} className={cn(classes, "no-underline text-inherit block")}>
          {inner}
        </Link>
        {referenceSummary && (
          <div className={stacked ? "px-3 pb-2.5" : "px-4 pb-2"}>{referenceSummary}</div>
        )}
      </div>
    );
  }

  return (
    <div className={classes}>
      {inner}
      {referenceSummary}
    </div>
  );
}
