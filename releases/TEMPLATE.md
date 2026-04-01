# AgentDash Release Notes Template

Use this template for `releases/vYYYY.MDD.P.md`.

## Summary

One short paragraph on what changed in this stable release and who should care.

## Highlights

- Highest-signal shipped feature or improvement.
- Second-highest release-worthy change.
- Third meaningful change, if needed.

## Operator Impact

- What board operators, reviewers, or maintainers will notice immediately.
- Any migration, config, or workflow changes required after upgrade.

## Fixes

- Important bug fix or reliability improvement.
- Important integration or packaging fix.

## Verification

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

## Notes

- Known limitations or follow-up work.
- Links to docs, plans, or migration notes when relevant.
