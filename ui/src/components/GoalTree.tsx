import type { Goal } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { StatusBadge } from "./StatusBadge";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { goalLevelLabel } from "../lib/goal-level-label";
import { useState } from "react";

interface GoalTreeProps {
  goals: Goal[];
  goalLink?: (goal: Goal) => string;
  onSelect?: (goal: Goal) => void;
}

interface GoalNodeProps {
  goal: Goal;
  children: Goal[];
  allGoals: Goal[];
  depth: number;
  goalLink?: (goal: Goal) => string;
  onSelect?: (goal: Goal) => void;
}

function GoalNode({ goal, children, allGoals, depth, goalLink, onSelect }: GoalNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = children.length > 0;
  const link = goalLink?.(goal);

  const inner = (
    <>
      {hasChildren ? (
        <button
          type="button"
          aria-label={expanded ? `Collapse ${goal.title}` : `Expand ${goal.title}`}
          aria-expanded={expanded}
          className="p-0.5 max-sm:-my-2 max-sm:-ml-3 max-sm:flex max-sm:h-11 max-sm:w-11 max-sm:shrink-0 max-sm:items-center max-sm:justify-center"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
          />
        </button>
      ) : (
        <span className="w-4 shrink-0 max-sm:-ml-3 max-sm:w-11" />
      )}
      {/* AgentDash: mobile redesign — on phones the title wraps under the
          level label instead of truncating; the status badge stays right. */}
      <span className="flex min-w-0 flex-1 items-center gap-2 max-sm:flex-col max-sm:items-start max-sm:gap-0.5">
        <span className="shrink-0 text-xs text-muted-foreground">{goalLevelLabel(goal.level)}</span>
        <span className="min-w-0 flex-1 truncate max-sm:whitespace-normal max-sm:break-words">{goal.title}</span>
      </span>
      <span className="shrink-0">
        <StatusBadge status={goal.status} />
      </span>
    </>
  );

  const classes = cn(
    "flex items-center gap-2 px-3 py-1.5 text-sm transition-colors cursor-pointer hover:bg-accent/50 max-sm:min-h-11 max-sm:py-2",
  );

  return (
    <div>
      {link ? (
        <Link
          to={link}
          className={cn(classes, "no-underline text-inherit")}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
        >
          {inner}
        </Link>
      ) : (
        <div
          className={classes}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
          onClick={() => onSelect?.(goal)}
        >
          {inner}
        </div>
      )}
      {hasChildren && expanded && (
        <div>
          {children.map((child) => (
            <GoalNode
              key={child.id}
              goal={child}
              children={allGoals.filter((g) => g.parentId === child.id)}
              allGoals={allGoals}
              depth={depth + 1}
              goalLink={goalLink}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function GoalTree({ goals, goalLink, onSelect }: GoalTreeProps) {
  const goalIds = new Set(goals.map((g) => g.id));
  const roots = goals.filter((g) => !g.parentId || !goalIds.has(g.parentId));

  if (goals.length === 0) {
    return <p className="text-sm text-muted-foreground">No goals.</p>;
  }

  return (
    <div className="border border-border py-1">
      {roots.map((goal) => (
        <GoalNode
          key={goal.id}
          goal={goal}
          children={goals.filter((g) => g.parentId === goal.id)}
          allGoals={goals}
          depth={0}
          goalLink={goalLink}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
