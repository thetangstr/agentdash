# Hosted hire dialog recovery

Goal: resolve the release-blocking lifecycle finding in PR #821 without changing hire authorization or the hosted/MK profile gates.

Files: `ui/src/components/NewAgentDialog.tsx` and its existing hosted component test. Worktree starts at PR #821 head `e56479af5`.

- [ ] Add rendered-component regressions for a successful hire followed by reopen, a closed/reopened dialog with a pending inbox lookup, and a company switch while a post is pending. Confirm failure on the PR head.
- [ ] Reset local form state for a new dialog/company session. Use a generation reference to prevent a stale callback from posting after the inbox lookup, closing another dialog session, or navigating after company selection changes. Release submission state in `finally` for the active request.
- [ ] Run targeted component tests and UI typecheck/build. Preserve the PR's existing hosted/profile assertions. Generate a small corrective patch for PR #821; do not edit Devin's worktree or push his branch.

The request already posted to its original company cannot be undone by closing a dialog. Do not automatically retry it or redirect a later dialog session. Company access and approval remain enforced by the server.

## Browser component proof

Using browser-harness and the real dialog/Radix/UI styles in an isolated loopback fixture, exact PR821 head reproduced a reopened disabled “Asking…” button after successful hire. The corrected component reopened with an enabled submit button after entering the next role, and completed a second synthetic hire. Before/after screenshots and fixture source are in the handoff folder `hire-dialog-proof-20260929/`. Company, health and CoS responses were simulated; this is browser component evidence, not hosted-box end-to-end proof. No live workspace writes occurred.
