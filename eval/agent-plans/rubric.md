# AgentTeamPlan A+ Rubric (AGE-41)

Each plan is scored on 8 dimensions, 0–10 each. A+ = average ≥ 8 AND every
dimension ≥ 8. Hard floor = no dimension below 6.

| Dim | What it measures | How we grade it (deterministic heuristics) |
|-----|------------------|---------------------------------------------|
| specificity | Plan talks about THIS goal, THIS company, not a generic template | rationale word-count, mentions of goal title/industry/company name/proposed roles |
| feasibility | A small team can realistically execute in the horizon | agent count (1–4 ideal), budget ≥ roster cost, playbook stage count |
| roi_clarity | Cost/benefit framing is explicit | non-zero budget cap, kill-switch + warn thresholds, KPI target ≠ baseline, dollar/ROI language in rationale |
| sequencing | Playbooks are ordered and time-boxed | ≥1 playbook, stages present, triggers (schedule/manual) set, rationale mentions sequencing |
| evidence | Benchmarks/sources cited | rationale cites ≥3 known sources (Gartner/Mixpanel/…), KPIs have unit + horizon |
| novelty | Avoids duplicating the existing roster | no duplicate roles from existingAgents, unique (role, skill-set) combos |
| accountability | Every KPI/playbook names an owner | playbook agent stages reference proposed roles, every agent has a non-trivial prompt, ≥1 skill each |
| risk | Risks + mitigations called out + budget guardrails | rationale mentions risk + mitigation, warn < kill-switch ≤ 100% |

Scoring is implemented deterministically in
`server/src/services/agent-plans-rubric.ts` so the eval suite runs offline
in CI without external LLM calls.
