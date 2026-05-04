// AgentDash (Phase G): Chris-CTO persona for deep-interview E2E tests.
//
// Chris is the CTO of BiggerCo (2,000 employees). His answers are rich enough
// that the deep-interview engine's ambiguity dimensions can score them across
// goal, constraints, and criteria.

export const chrisCtoPersona = {
  name: "Chris",
  email: "chris@biggerco.test",
  password: "test-password-1234",
  companyName: "BiggerCo",

  // Round 1: primary goal — scoped rollout of AI agents across engineering orgs.
  // Round 2: constraints — compliance, budget cap, existing stack lock-in.
  // Round 3: success criteria — measurable outcomes the CTO will use to judge success.
  interviewAnswers: [
    // Round 1: What's your primary goal for this rollout?
    "Our primary goal is to reduce cycle time for our engineering teams by 40% over the next two quarters. We have about 2,000 engineers across 14 squads and they spend too much time on incident triage, PR review bottlenecks, and on-call escalation. I want AI agents handling Tier-1 incident diagnosis, auto-routing pages to the right squad, and summarizing PRs so reviewers spend under two minutes per review instead of fifteen. This is squarely a velocity and quality initiative — not cost-cutting.",

    // Round 2: What constraints matter most?
    "Three hard constraints. First, SOC 2 Type II compliance — any agent that touches production logs or code must operate within our existing security perimeter; no data leaves our VPC. Second, we have a $1.2M annual budget for tooling and we've already committed $400K to Datadog and PagerDuty contracts, so the net envelope is $800K. Third, we're locked into GitHub Enterprise and Jira — the agents must integrate natively, no new ticketing system. The CIO has a standing veto on any tool that requires a separate auth silo.",

    // Round 3: How will you know this succeeded?
    "Three measurable outcomes after 90 days. One: mean time to triage (MTTT) drops from 47 minutes to under 12 minutes as measured in PagerDuty. Two: PR review turnaround time at P50 drops from 4.2 hours to under 2 hours tracked in GitHub. Three: engineer satisfaction on the quarterly pulse survey goes from 62% to at least 75% favorable on the 'I have the tools I need' question. If we hit all three, we roll out to the remaining 9 squads; if we miss two or more, we pause and reassess the agent approach.",
  ],
};
