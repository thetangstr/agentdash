# AgentDash — Client Onboarding Flow

## End-to-End Flow Diagram

```
PHASE 1: INFRASTRUCTURE                    PHASE 2: COMPANY SETUP
┌─────────────────────────┐                ┌──────────────────────────────────────┐
│ 1. Deploy AgentDash     │                │ 5. Create company                    │
│    (Docker / bare metal)│                │    POST /api/companies               │
│                         │                │                                      │
│ 2. Health check         │                │ 6. Start onboarding session          │
│    GET /api/health      │───────────────▶│    POST /api/companies/:id/          │
│                         │                │         onboarding/sessions           │
│ 3. Bootstrap admin      │                │                                      │
│    agentdash auth       │                │ 7. Ingest company sources            │
│    bootstrap-ceo        │                │    POST .../sessions/:sid/sources    │
│                         │                │    (paste description, docs, wiki)   │
│ 4. Accept invite        │                │                                      │
│    (Board Operator)     │                │ 8. Extract context (LLM)             │
└─────────────────────────┘                │    POST .../sessions/:sid/extract    │
                                           │    → domain, products, team, stack   │
                                           │                                      │
                                           │ 9. Set company goals                 │
                                           │    POST /api/companies/:id/goals     │
                                           └──────────────────┬───────────────────┘
                                                              │
                                                              ▼
PHASE 3: GOVERNANCE                        PHASE 4: AGENT TEMPLATES
┌─────────────────────────┐                ┌──────────────────────────────────────┐
│ 10. Create departments  │                │ 13. Create agent templates            │
│     POST .../departments│                │     POST .../agent-templates          │
│     (Eng, Growth, Ops)  │                │     (Tech Lead, Engineer, QA, etc.)  │
│                         │                │                                      │
│ 11. Security policies   │◀───────────────│ 14. Suggest team from context        │
│     POST .../security-  │                │     POST .../suggest-team            │
│     policies            │                │     (LLM ranks templates vs context) │
│     (deploy gate, rate  │                │                                      │
│      limit, blast       │                │ 15. Complete onboarding session      │
│      radius)            │                │     POST .../sessions/:sid/complete  │
│                         │                └──────────────────┬───────────────────┘
│ 12. Configure sandbox   │                                   │
│     POST .../agents/    │                                   │
│     :id/sandbox         │                                   ▼
└─────────────────────────┘
                                           PHASE 5: AGENT DEPLOYMENT
                                           ┌──────────────────────────────────────┐
                                           │ 16. Spawn agents from templates      │
                                           │     POST .../spawn-requests          │
                                           │     → creates approval               │
                                           │                                      │
                                           │ 17. Approve spawn request            │
                                           │     POST /api/approvals/:id/approve  │
                                           │     → agents created                 │
                                           │                                      │
                                           │ 18. Set agent OKRs                   │
                                           │     POST .../agents/:id/okrs         │
                                           │                                      │
                                           │ 19. Create skills for agents         │
                                           │     POST .../skills                  │
                                           │     POST .../skills/:id/versions     │
                                           └──────────────────┬───────────────────┘
                                                              │
                                                              ▼
PHASE 6: WORK SETUP                        PHASE 7: CRM & INTEGRATIONS
┌─────────────────────────┐                ┌──────────────────────────────────────┐
│ 20. Create project      │                │ 24. Configure HubSpot               │
│     POST .../projects   │                │     POST .../hubspot/config          │
│                         │                │     (access token + portal ID)       │
│ 21. Create issues       │                │                                      │
│     POST .../issues     │                │ 25. Test HubSpot connection          │
│     (tasks with clear   │                │     POST .../hubspot/test            │
│      acceptance criteria)│                │                                      │
│                         │                │ 26. Sync CRM data                    │
│ 22. Add dependencies    │                │     POST .../hubspot/sync            │
│     POST .../issues/    │                │     → contacts, companies, deals     │
│     :id/dependencies    │                │                                      │
│     (A → B → C chain)   │                │ 27. Verify pipeline                  │
│                         │                │     GET .../crm/pipeline             │
│ 23. Assign to agents    │                └──────────────────┬───────────────────┘
│     PATCH /api/issues/  │                                   │
│     :id                 │                                   ▼
└─────────────────────────┘
                                           PHASE 8: VERIFY & GO LIVE
                                           ┌──────────────────────────────────────┐
                                           │ 28. Check dashboard                  │
                                           │     GET .../dashboard                │
                                           │     → agents, tasks, costs, activity │
                                           │                                      │
                                           │ 29. Verify capacity                  │
                                           │     GET .../capacity/workforce       │
                                           │     GET .../capacity/pipeline        │
                                           │                                      │
                                           │ 30. Kill switch test                 │
                                           │     POST .../kill-switch (halt)      │
                                           │     POST .../kill-switch/resume      │
                                           │                                      │
                                           │ 31. Start research cycle (optional)  │
                                           │     POST .../research-cycles         │
                                           │                                      │
                                           │ ✅ READY — heartbeat picks up tasks  │
                                           └──────────────────────────────────────┘
```

## Simulated Client Profile

**Company:** NovaTech Solutions
**Size:** 45 employees
**Industry:** B2B SaaS (analytics platform for SMBs)
**CRM:** HubSpot
**Board Operator:** Sarah Chen (CEO)
**Initial scope:** Engineering department (start with 3 agents)
**Goal:** Ship v2.0 analytics dashboard in 6 weeks
