// AgentDash: CoS chat header — identity, context, status
import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";

export interface ChatHeaderProps {
  agentName?: string;
  agentRole?: string;
  stepCurrent?: number;
  stepTotal?: number;
  /** AgentDash: a compact trailing action (e.g. a link), shown at the right edge of the header. */
  action?: ReactNode;
}

export function ChatHeader({
  agentName = "Chief of Staff",
  agentRole = "Setting up your AgentDash workspace",
  stepCurrent,
  stepTotal,
  action,
}: ChatHeaderProps) {
  return (
    <div
      data-testid="chat-header"
      className="flex items-center justify-between gap-3 px-6 py-2.5 border-b border-border-soft bg-surface-raised shrink-0 max-sm:px-4 max-sm:py-1.5"
    >
      {/* Left: avatar + identity */}
      <div className="flex min-w-0 items-center gap-3">
        <div className="relative shrink-0">
          <div className="w-9 h-9 rounded-full bg-accent-500 flex items-center justify-center shadow-sm max-sm:w-8 max-sm:h-8">
            <Sparkles className="w-4 h-4 text-text-inverse" aria-hidden="true" />
          </div>
          {/* Online dot */}
          <span
            className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-surface-raised"
            aria-label="Online"
          />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold text-text-primary leading-tight">{agentName}</span>
          {/* Phones keep the header to one line of context. */}
          <span className="text-xs text-text-tertiary leading-tight mt-0.5 max-sm:truncate">{agentRole}</span>
        </div>
      </div>

      {/* Right: step progress */}
      {typeof stepCurrent === "number" && typeof stepTotal === "number" && (
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {Array.from({ length: stepTotal }).map((_, i) => (
              <span
                key={i}
                className={`w-5 h-1 rounded-full transition-colors ${
                  i < stepCurrent ? "bg-accent-500" : "bg-border-soft"
                }`}
              />
            ))}
          </div>
          <span className="text-xs text-text-tertiary tabular-nums">
            {stepCurrent} / {stepTotal}
          </span>
        </div>
      )}
      {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
    </div>
  );
}
