# Public docs verification, October 7

Production source candidate: 9f2306a77736ca362feb1d5a729ce844be8bad3a. Root used built files on isolated port3476 with synthetic health/session and401 for every other API; no proxy to any running instance.

Before: public www /docs redirected to /find. [Before screenshot](assets/2026-10-07-docs/before-desktop.png).
After: local built docs renders anonymously, including API reference. [Desktop](assets/2026-10-07-docs/after-desktop.png), [390px mobile](assets/2026-10-07-docs/after-mobile.png).

Fresh interaction evidence:
- /docs resolves to the introduction; full doc body and sidebar rendered.
- Searching budget produced matching results; choosing Costs and Budgets navigated to its deep link. A direct reload rendered the same article.
- At390px, document width remained390px, with no horizontal overflow; Menu opened/closed the sidebar.
- /docs/mcp/overview and /docs/api/reference rendered. Scalar lazy reference, operation headings and local openapi download loaded; no Try It API request was sent.
- Existing /whats-new and launch-week article rendered and retained header/footer Docs links.

Chrome disconnected before the final header-link click could be confirmed, and now requires its own Allow remote debugging permission. Unit tests cover link targets. Final public deployment/rendered navigation proof remains pending; screenshots are local built proof, not deployed proof. Public-host URL substitution and deny-scanner edge cases have separate unit evidence.
