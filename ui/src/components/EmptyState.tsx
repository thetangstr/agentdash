import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";

interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  action?: string;
  onAction?: () => void;
  /**
   * AgentDash: UX-11 — person-facing empty states navigate somewhere useful
   * (Ask, Connect GitHub) rather than fire a callback. When `actionTo` is set
   * the action renders as a link button and `onAction` is ignored.
   */
  actionTo?: string;
  /** Icon inside the action button. Defaults to Plus; pass null for none. */
  actionIcon?: LucideIcon | null;
}

export function EmptyState({ icon: Icon, message, action, onAction, actionTo, actionIcon }: EmptyStateProps) {
  const ActionIcon = actionIcon === undefined ? Plus : actionIcon;
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted/50 p-4 mb-4">
        <Icon className="h-10 w-10 text-muted-foreground/50" />
      </div>
      <p className="text-sm text-muted-foreground mb-4">{message}</p>
      {action && actionTo ? (
        <Button asChild>
          <Link to={actionTo}>
            {ActionIcon ? <ActionIcon className="h-4 w-4 mr-1.5" /> : null}
            {action}
          </Link>
        </Button>
      ) : action && onAction ? (
        <Button onClick={onAction}>
          {ActionIcon ? <ActionIcon className="h-4 w-4 mr-1.5" /> : null}
          {action}
        </Button>
      ) : null}
    </div>
  );
}
