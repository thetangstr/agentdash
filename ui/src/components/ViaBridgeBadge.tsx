import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import { viaBridgeText, type BridgeVia } from "../lib/bridge-provenance";

/**
 * "via bridge (<endpoint label>)" on something a person sent from their own
 * Claude or Codex rather than from this page: a comment, a document revision,
 * an answer, an attachment. It is still theirs; this says which way it came,
 * and from which of their connected machines.
 */
export function ViaBridgeBadge({ via, className }: { via: BridgeVia | null | undefined; className?: string }) {
  if (!via) return null;
  return (
    <Badge
      variant="outline"
      data-testid="via-bridge-badge"
      className={cn("text-[10px] font-normal text-muted-foreground", className)}
      title="Sent by this person from their own Claude or Codex through the AgentDash bridge, after their go."
    >
      {viaBridgeText(via)}
    </Badge>
  );
}
