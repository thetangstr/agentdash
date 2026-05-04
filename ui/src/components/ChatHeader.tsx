// AgentDash: CoS chat header — identity, context, status
import { Sparkles } from "lucide-react";

export interface ChatHeaderProps {
  agentName?: string;
  agentRole?: string;
  stepCurrent?: number;
  stepTotal?: number;
}

export function ChatHeader({
  agentName = "Chief of Staff",
  agentRole = "Setting up your AgentDash workspace",
  stepCurrent,
  stepTotal,
}: ChatHeaderProps) {
  return (
    <div className="flex items-center justify-between px-6 py-2.5 border-b border-border-soft bg-surface-raised shrink-0">
      {/* Left: avatar + identity */}
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="w-9 h-9 rounded-full bg-accent-500 flex items-center justify-center shadow-sm">
            <Sparkles className="w-4 h-4 text-text-inverse" aria-hidden="true" />
          </div>
          {/* Online dot */}
          <span
            className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-surface-raised"
            aria-label="Online"
          />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-text-primary leading-tight">{agentName}</span>
          <span className="text-xs text-text-tertiary leading-tight mt-0.5">{agentRole}</span>
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
    </div>
  );
}
