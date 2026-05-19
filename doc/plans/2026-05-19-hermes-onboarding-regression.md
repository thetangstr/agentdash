# Hermes Onboarding Regression Plan

## Goal

Keep the Chief-of-Staff onboarding flow from drifting back to Claude-local when a local/self-hosted deployment expects Hermes agents.

## CI Lane

Run this focused lane on every pull request and release verification:

```sh
pnpm run test:regression:hermes-onboarding
```

The lane is intentionally small and covers:

- `packages/shared/src/validators/agent-plan.test.ts` — `agent_plan_proposal_v1` accepts `hermes_local`.
- `server/src/__tests__/cos-replier.test.ts` — CoS plan prompts advertise `hermes_local`.
- `server/src/__tests__/onboarding-v2-routes.test.ts` — `/confirm-plan` materializes Hermes plan cards into Hermes agents.
- `server/src/__tests__/hermes-local-adapter-patch.test.ts` — Hermes environment checks do not fail just because no LLM key exists in AgentDash env, and Hermes may use its own default model.

## Boundary

This CI lane does not run a live Hermes model or mutate a target machine. Live adapter execution remains part of the managed-agent target test loop on `/Users/maxiaoer/workspace/agentdash_dev`; production stays read-only except health checks unless explicitly authorized.
