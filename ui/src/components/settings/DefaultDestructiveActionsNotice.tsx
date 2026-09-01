import { DEFAULT_DESTRUCTIVE_ACTION_CLASSES } from "@paperclipai/shared";

/**
 * AgentDash-MK: read-only onboarding display of the default destructive-action
 * class list (T5a-3). See doc/plans/2026-08-04-t5-destructive-classifier.md.
 *
 * Shown to the owner at agentdash_mk company governance setup, next to the
 * `destructiveActions` ceiling control, so they can see exactly which agent
 * actions that mode applies to. The list is the shared code constant the
 * server-side classifier enforces (T5a-1) — the display and the enforcement
 * import the same truth and can never disagree.
 *
 * READ-ONLY in T5a. The owner-ADD capability ("Add anything else your business
 * treats as sensitive") needs to persist custom classes, which needs a
 * migration, and is out of scope here — that is T5b.
 */
export function DefaultDestructiveActionsNotice() {
  return (
    <section
      aria-labelledby="default-destructive-actions-heading"
      className="space-y-3 rounded-lg border p-4"
    >
      <div>
        <h3
          id="default-destructive-actions-heading"
          className="text-sm font-semibold"
        >
          Actions that require approval by default
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          These agent actions require your approval by default. Each is gated
          the moment an agent tries it, according to the destructive-actions
          setting on the agent&rsquo;s ceiling.
        </p>
      </div>

      <ul className="space-y-2">
        {DEFAULT_DESTRUCTIVE_ACTION_CLASSES.map((entry) => (
          <li key={entry.key} className="text-xs">
            <p className="font-medium">{entry.label}</p>
            <p className="text-muted-foreground">{entry.rationale}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
