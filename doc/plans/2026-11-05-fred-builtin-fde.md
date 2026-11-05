# Fred: first local release

Fred is AgentDash's company-scoped FDE guide. This implementation is local and awaiting the normal release gates.

## Owner workflow

1. Select the company and open **Fred** from the sidebar or workforce setup (`/:prefix/company/fred`). The nested route preserves existing companies named FRED.
2. Choose an installed agent runtime, an explicit monthly budget and company-sharing consent. **Set up Fred** creates/repairs one registered guide and a backlog discovery thread. It makes no model call.
3. Save an adoption brief: desired result, one useful future job, observable criteria, permitted sources/actions and a baseline/observation window where known.
4. Select **Start discovery**. This explicitly requests normal agent execution. The native task/chat contains questions, tool calls, memory, outputs and run receipts.
5. Review Fred's source-linked recommendation and proposed setup through existing Workforce, Profile and Access controls. Fred does not approve its own changes or borrow owner credentials.
6. Judge the eventual job against its agreed criteria. Execution, accepted work and later business results are separate.

The first discovery job produces a recommendation and next decision. It does not itself resolve a customer support case, send an invoice, hire a specialist or prove a return on investment.

## Safety and recovery

Fred is registered by company identity, not its name. Existing CoS and same-name agents remain unchanged. One protected registered guide is excluded from worker capacity; ordinary model usage, quota and hard-stop budgets still apply.

Setup is non-executing and recurring checks are disabled. Native hiring approval, pause, budget and accountable-owner blocks remain effective. Repeated setup/start requests reuse the accepted identity/job. Interrupted managed-file setup can be retried. Missing Fred instructions block Start and restore the Fred mandate rather than silently creating a generic worker. Terminated or active work is not silently recreated or interrupted.

The brief and discovery thread are explicitly **company-shared**. The current local harness is not a complete host sandbox, and this release does not establish same-company agent-to-agent private-data isolation. Do not put private credentials or unapproved information into a shared brief.

A changed/missing native adoption document invalidates discovery start until an owner reconfirms criteria. Runs remain pinned to the criteria at their start. Missing proof, a persuasive claim and a different task's successful run cannot establish discovery success. The page links to native evidence; it does not certify task acceptance or business outcomes.

## Testing and rollout

- New additive migration: 0158_fred_builtin_guide, using the standard migration workflow.
- First offline execution proof uses the registered claude_local adapter and a contained deterministic executable. It proves AgentDash orchestration/tools/state, not the installed Claude client's or a live model's judgment.
- scripts/fred-runtime.mjs is the reproducible isolated UI/execution fixture. Read its --describe output and use a fresh synthetic company; do not point it at a customer database.
- Genuine human labels, actual hands-on correction effort, external service success and delayed business value remain pending unless separately recorded.
- Old code can retain the additive schema, but counts Fred as an ordinary agent; do not claim capacity-policy parity across an old-code rollback.
- Merge, publication and instance upgrades require the existing explicit release approval. No production entitlement, credentials or customer state are changed by this local branch.
