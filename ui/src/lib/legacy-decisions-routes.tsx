import { Navigate, Route } from "@/lib/router";

/**
 * AgentDash: UX-7 (GH #788) + one UX (doc/plans/2026-09-30-one-ux.md) —
 * Decisions replaced the Inbox and Approvals lists for every company. These
 * are the old list URLs; each redirects to /decisions so bookmarks (MK users
 * had /inbox/mine and /approvals/pending) keep landing somewhere useful.
 *
 * Not here on purpose: /approvals/:approvalId (the detail a Decisions row
 * opens), /inbox/requests (the join queue) and /inbox/override (the admin
 * override view) — those are live pages, not lists Decisions replaced.
 */
export const LEGACY_DECISIONS_PATHS = [
  "approvals",
  "approvals/pending",
  "approvals/all",
  "inbox",
  "inbox/mine",
  "inbox/recent",
  "inbox/unread",
  "inbox/all",
  "inbox/company",
  "inbox/new",
] as const;

/** Route elements for the board router; render inside a <Routes>. */
export function legacyDecisionsRoutes() {
  return LEGACY_DECISIONS_PATHS.map((path) => (
    <Route key={path} path={path} element={<Navigate to="/decisions" replace />} />
  ));
}
