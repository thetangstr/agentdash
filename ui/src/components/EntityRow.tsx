import { type ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

interface EntityRowProps {
  leading?: ReactNode;
  identifier?: string;
  title: string;
  /**
   * Rendered immediately after the title, inside the same line.
   *
   * For a fact about what the row *is* rather than what state it is in — an
   * agent's kind, say. Those belong next to the name, where someone reads
   * identity, instead of in `trailing`, where the fixed-width status columns
   * leave no room for a third pill.
   */
  titleBadge?: ReactNode;
  subtitle?: string;
  trailing?: ReactNode;
  selected?: boolean;
  to?: string;
  onClick?: () => void;
  className?: string;
}

export function EntityRow({
  leading,
  identifier,
  title,
  titleBadge,
  subtitle,
  trailing,
  selected,
  to,
  onClick,
  className,
}: EntityRowProps) {
  const isClickable = !!(to || onClick);
  const classes = cn(
    "flex items-center gap-3 px-4 py-2 text-sm border-b border-border last:border-b-0 transition-colors",
    isClickable && "cursor-pointer hover:bg-accent/50",
    selected && "bg-accent/30",
    className
  );

  const content = (
    <>
      {leading && <div className="flex items-center gap-2 shrink-0">{leading}</div>}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {identifier && (
            <span className="text-xs text-muted-foreground font-mono shrink-0 relative top-[1px]">
              {identifier}
            </span>
          )}
          <span className="truncate">{title}</span>
          {titleBadge}
        </div>
        {subtitle && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{subtitle}</p>
        )}
      </div>
      {trailing && <div className="flex items-center gap-2 shrink-0">{trailing}</div>}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={cn(classes, "no-underline text-inherit")} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <div className={classes} onClick={onClick}>
      {content}
    </div>
  );
}
