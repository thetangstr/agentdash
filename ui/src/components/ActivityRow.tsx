import { Link } from "@/lib/router";
import { Identity } from "./Identity";
import { IssueReferenceActivitySummary } from "./IssueReferenceActivitySummary";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { formatActivityVerb } from "../lib/activity-format";
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

  const name = isHeartbeatEvent
    ? (heartbeatAgentId ? entityNameMap.get(`agent:${heartbeatAgentId}`) : null)
    : entityNameMap.get(`${event.entityType}:${event.entityId}`);

  const entityTitle = entityTitleMap?.get(`${event.entityType}:${event.entityId}`);

  const link = isHeartbeatEvent && heartbeatAgentId
    ? `/agents/${heartbeatAgentId}/runs/${event.entityId}`
    : entityLink(event.entityType, event.entityId, name);

  const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
  const userProfile = event.actorType === "user" ? userProfileMap?.get(event.actorId) : null;
  const actorName = actor?.name ?? (event.actorType === "system" ? "System" : userProfile?.label ?? (event.actorType === "user" ? "Board" : event.actorId || "Unknown"));
  const actorAvatarUrl = userProfile?.image ?? null;

  const stacked = layout === "stacked";
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
      <IssueReferenceActivitySummary event={event} />
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
      <IssueReferenceActivitySummary event={event} />
    </div>
  );

  const classes = cn(
    stacked ? "min-h-11 px-3 py-2.5 text-sm" : "px-4 py-2 text-sm",
    link && "cursor-pointer hover:bg-accent/50 transition-colors",
    className,
  );

  if (link) {
    return (
      <Link to={link} className={cn(classes, "no-underline text-inherit block")}>
        {inner}
      </Link>
    );
  }

  return (
    <div className={classes}>
      {inner}
    </div>
  );
}
