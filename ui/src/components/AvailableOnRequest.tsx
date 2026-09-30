// AgentDash: one UX for every company (see the one-UX decision record, 2026-09-30). The UI does
// not branch on the company's product profile. Capabilities that are still
// switched on per workspace (stewardship, connector sends, agent ceilings, …)
// stay gated on the SERVER, which answers 404 ("Company not found") from
// `requireProductProfile` when the capability is off. Pages show every entry
// point to everyone and, when the server says the capability is off, render
// this calm empty state instead of an error.
import { ApiError } from "@/api/client";

/**
 * True when an error is the server's "this capability is not on for this
 * workspace" answer. `requireProductProfile` throws 404; a 403 from a
 * capability gate reads the same way to the user.
 */
export function isCapabilityOff(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 403);
}

/**
 * Same as {@link isCapabilityOff} but only for the 404 the capability gate
 * sends. Use this where a 403 means something else on that route (for example
 * "you are not an admin").
 */
export function isCapabilityNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function AvailableOnRequest({
  title,
  capability,
  className,
  compact = false,
}: {
  /** Page or panel heading, shown above the message when set. */
  title?: string;
  /** Plain-language name of the capability, e.g. "stewardship". */
  capability: string;
  className?: string;
  /** Panel-sized rendering (inside a settings card) instead of page-sized. */
  compact?: boolean;
}) {
  return (
    <div
      className={className ?? (compact ? "" : "p-6")}
      data-testid="available-on-request"
    >
      {title ? (
        compact ? (
          <h2 className="text-sm font-semibold">{title}</h2>
        ) : (
          <h1 className="text-lg font-semibold">{title}</h1>
        )
      ) : null}
      <p className={`${title ? "mt-2 " : ""}text-sm text-muted-foreground`}>
        Available on request — ask us to turn on {capability} for your workspace.
      </p>
    </div>
  );
}
