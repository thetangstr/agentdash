# CoS Pilot Onboarding

## Purpose

AgentDash now supports a contained 30-day Chief of Staff pilot as an onboarding outcome. This keeps the first AI rollout centered on one CoS agent instead of immediately proposing a larger agent team.

## User Experience

- The `/cos` surface remains the existing AgentDash chat experience and design system.
- The CoS proposes a `cos_pilot_proposal_v1` card containing a Delegation Contract and a 30-day pilot plan.
- The right rail gives a lightweight setup and traceability hint during onboarding, then switches to operating-mode language after launch.

## Launch Behavior

Confirming the pilot through `POST /api/onboarding/confirm-plan`:

- creates a `30-day Chief of Staff pilot` Project,
- creates traceable pilot Issues for contract/access, RFP pipeline, admin dry-runs, and evidence reporting,
- enables the CoS heartbeat for daily business-day briefs,
- records `cos_pilot_launched` activity with the pilot evidence fields,
- keeps approval gates explicit for external submissions and live billing, payroll, HR, or recruiting changes.

Legacy `agent_plan_proposal_v1` cards still materialize agent-team plans for existing conversations.
