/**
 * What someone sees when they open a direction surface they may not change.
 *
 * The alternative — rendering the controls and letting each one 403 — is how a
 * permission boundary gets mistaken for a broken product. This says who may
 * change it, so the reader knows what to do next rather than wondering whether
 * to file a bug.
 *
 * It deliberately does not apologise or hide the fact. A member is meant to see
 * the goals and projects they are working toward; only the editing is withheld.
 */
export function DirectionRestricted({
  what,
  role,
}: {
  what: string;
  role: string | null;
}) {
  return (
    <div className="max-w-2xl rounded-lg border border-border bg-muted/40 p-4">
      <h3 className="text-sm font-semibold">Only an owner, admin or operator can change {what}.</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {role ? `You are a ${role} of this company.` : "You do not have that role here."} You can see
        everything on this project — this is the part that is set for you, so the work and the thing
        the work is measured against do not move at the same time.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Ask whoever owns this company if it needs to change.
      </p>
    </div>
  );
}
