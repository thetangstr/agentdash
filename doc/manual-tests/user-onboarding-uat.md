# User onboarding UAT scripts

Manual UAT pack for AgentDash onboarding surfaces that differ from upstream Paperclip.

Scope covers requested feature areas:

1. CoS-led workspace experience
2. Multi-human + CoS chat
3. Agent readiness `/assess`
4. Free/Pro billing
6. CoS onboarding + invites
7. Goals / eval / HITL
8. Deep-interview engine

Feature 5, UI redesign, is intentionally out of scope except for obvious usability defects found while running these scripts.

**Estimated time:** 90-150 minutes for a full pass.
**Risk:** creates test users, companies, agents, invites, goals, projects, issues, verdicts, billing records, and activity rows. Run only in `agentdash_dev`, staging, or a disposable local database.

---

## 0. Test Run Header

Copy this block into the test report or GitHub issue body:

```text
UAT pack: doc/manual-tests/user-onboarding-uat.md
Tester:
Date:
Environment:
Base URL:
Git SHA / release version:
Database: local embedded / staging / other
Deployment mode: local_trusted / authenticated
Browser + OS:
LLM provider configured: yes / no
Stripe test mode configured: yes / no
Resend configured: yes / no
Result: pass / fail / blocked
```

## 1. Pre-flight

### 1.1 Confirm environment

For automated local browser UAT, use a disposable instance and disable API rate
limits so page polling does not produce false 429 failures:

```sh
PAPERCLIP_HOME=/tmp/agentdash-uat-paperclip \
PAPERCLIP_INSTANCE_ID=uat \
PORT=3199 \
AGENTDASH_DEV_MODE=true \
AGENTDASH_RATE_LIMIT_DISABLED=true \
PAPERCLIP_E2E_SKIP_LLM=true \
AGENTDASH_DEEP_INTERVIEW_ASSESS=true \
pnpm dev --restart
```

Run:

```sh
curl -sS "$AGENTDASH_BASE/api/health" | jq .
```

Expected:

- `status` is `ok`.
- `deploymentMode` is the intended mode.
- You are not pointed at production unless this is an explicitly approved production smoke.

### 1.2 Confirm build identity

Run from the checkout if testing from source:

```sh
git status --short
git log -1 --oneline
```

Record the SHA in the test report.

### 1.3 Recommended test identities

Use unique emails per run:

```text
Founder: uat-founder+<date>-<initials>@example.com
Teammate: uat-team+<date>-<initials>@example.com
Second teammate: uat-ops+<date>-<initials>@example.com
```

Use this business scenario unless the test case says otherwise:

```text
Company: Northstar Compliance Labs
Short-term goal: launch an AI-assisted SOC 2 onboarding product in 90 days
Long-term goal: build an AI operations team that can run customer onboarding without adding headcount
Current bottleneck: founders manually write checklists, chase documents, and answer repetitive customer questions
Success metric: 10 pilot customers onboarded with under 2 hours of founder time per customer
```

### 1.4 Optional billing setup

Billing scripts require Stripe test mode. If Stripe is not configured, mark billing payment-provider steps as blocked but still run cap/upgrade UI checks.

Expected env/config:

```text
STRIPE_SECRET_KEY
STRIPE_PRO_PRICE_ID
STRIPE_WEBHOOK_SECRET
BILLING_PUBLIC_BASE_URL
```

When testing locally, run Stripe CLI webhook forwarding:

```sh
stripe listen --forward-to "$AGENTDASH_BASE/api/billing/webhook"
```

## 2. Feature 1: CoS-Led Workspace Experience

### UAT-ONB-01: First-time user lands in CoS-led setup

**Purpose:** Validate that a new user is guided by the Chief of Staff rather than dropped into a generic dashboard.

**Preconditions:**

- No existing company for the founder test user.
- Authenticated deployment: founder can create an account.
- Local trusted deployment: use a clean embedded DB or a fresh browser profile.

**Steps:**

1. Open `$AGENTDASH_BASE`.
2. Choose the sign-up/start-free path.
3. Create the founder account or enter the local onboarding flow.
4. After sign-up, observe the first route and first meaningful screen.
5. If not automatically redirected, open `/cos`.
6. Wait for workspace setup to complete.

**Expected:**

- User sees a CoS-oriented onboarding/chat surface or a clear path to start onboarding.
- Workspace bootstrap does not require manual database or agent setup.
- CoS identity is visible.
- No raw setup logs, JSON dumps, or unexplained internal errors are shown.
- A company and CoS agent exist after bootstrap.

**Evidence:**

- Screenshot of the first post-signup screen.
- Screenshot of the CoS chat loaded state.
- Network/API evidence or DB evidence for company + CoS creation, if available.

### UAT-ONB-02: CoS captures user goals and presents a plan

**Purpose:** Validate the CoS-led planning loop from business context to proposed agent team.

**Steps:**

1. In `/cos`, answer the opening CoS question using the standard business scenario.
2. Provide short-term and long-term goals when asked.
3. Answer at least one clarifying question with constraints: small team, 90-day deadline, limited founder time.
4. Continue until CoS presents a structured agent plan proposal card.
5. Review the plan content.

**Expected:**

- CoS asks relevant follow-up questions, not a generic survey loop.
- Plan card appears inline in chat.
- Plan includes at least one proposed agent with name, role, adapter type, responsibilities, and rationale.
- Plan connects back to short-term and long-term goals.
- User has visible actions to set up the plan or revise it.

**Evidence:**

- Screenshot of captured goal conversation.
- Screenshot of `agent_plan_proposal_v1` card.
- Note the proposed agents and whether they match the scenario.

### UAT-ONB-03: User can revise the CoS plan before setup

**Purpose:** Validate that onboarding is not a one-shot wizard.

**Steps:**

1. On the plan card, click **Let me revise**.
2. Enter: `Replace the support agent with an implementation coordinator and make the first milestone onboarding 3 pilot customers.`
3. Submit the revision.
4. Wait for the revised plan card or CoS response.

**Expected:**

- Revision UI opens without losing the original plan.
- User can submit free-text feedback.
- CoS posts a revised plan or a clear explanation if revision is unavailable.
- If the revision endpoint is not implemented in the test build, the UI must fail gracefully and not break the conversation.

**Evidence:**

- Screenshot of revision input.
- Screenshot of revised plan or graceful error.

### UAT-ONB-04: Confirming plan materializes onboarding objects

**Purpose:** Validate that CoS plan confirmation creates real workspace state.

**Steps:**

1. On the current plan card, click **Set it up**.
2. Wait for confirmation in the conversation.
3. Open `/agents/all`.
4. Open `/goals`.
5. Open `/projects` and `/issues` if the flow creates launch work.

**Expected:**

- Confirm action does not double-create agents when clicked once.
- New agent rows appear with readable names/roles from the plan.
- Captured onboarding goals are visible in `/goals`.
- Any starter project/issue links back to the selected or materialized goal.
- Conversation remains usable after materialization.

**Evidence:**

- Screenshot of closing CoS message.
- Screenshot of new agent list.
- Screenshot of goals created from onboarding.

## 3. Feature 2: Multi-Human + CoS Chat

### UAT-CHAT-01: Persistent conversation survives reload

**Purpose:** Validate that onboarding chat is a persistent company conversation.

**Steps:**

1. In `/cos`, send: `Can you summarize what we decided so far?`
2. Wait for CoS reply.
3. Refresh the browser.
4. Reopen `/cos` if redirected.

**Expected:**

- Previous messages remain visible.
- User does not lose plan cards or invite cards.
- Composer is still usable.
- No duplicate bootstrap conversation is created for the same company.

**Evidence:**

- Screenshot before refresh.
- Screenshot after refresh with same conversation history.

### UAT-CHAT-02: Agent mention summon from onboarding chat

**Purpose:** Validate `@mention` routing from CoS chat to a direct-report agent.

**Preconditions:**

- At least one non-CoS agent was created during plan confirmation.

**Steps:**

1. In `/cos`, type `@` in the composer.
2. Confirm a mention/typeahead appears with created agents.
3. Select or type the agent name, then send: `@<agent> what should you do first for our pilot onboarding goal?`
4. Wait for the reply.

**Expected:**

- Mention suggestion includes company agents.
- Message posts normally.
- Summoned agent or CoS-mediated response appears.
- Response is contextual to the onboarding conversation and pilot goal.
- No unrelated agent from another company appears in mention suggestions.

**Evidence:**

- Screenshot of mention options.
- Screenshot of agent reply.

### UAT-CHAT-03: Invited teammate joins same conversation

**Purpose:** Validate multi-human participation in onboarding.

**Preconditions:**

- An invite link has been generated in UAT-INV-01, or create one from Company Settings.

**Steps:**

1. Open the invite link in a separate browser profile or incognito window.
2. Sign up or sign in as the teammate test user.
3. Accept the invite.
4. Navigate to `/cos`.
5. From the teammate session, send: `I joined from the invite. What did I miss?`
6. From the founder session, verify the teammate message appears.

**Expected:**

- Teammate lands in the same company, not a new empty company.
- Teammate can access the same CoS conversation.
- Founder sees the teammate message without a full page refresh, or after refresh if WebSocket reconnection is slow.
- CoS can respond with the existing onboarding context.

**Evidence:**

- Screenshot of invite acceptance.
- Screenshot from both sessions showing the same conversation.

## 4. Feature 3: Agent Readiness `/assess`

### UAT-ASSESS-01: Anonymous visitor is routed to sign-up from `/assess`

**Purpose:** Validate the onboarding bridge from marketing assessment to workspace creation.

**Steps:**

1. In a fresh anonymous browser profile, open `$AGENTDASH_BASE/assess`.
2. Observe the page.
3. Click **Start free**.

**Expected:**

- Page explains assessment requires a workspace.
- User sees clear sign-up/start-free CTA.
- CTA leads to account creation or local onboarding.
- No blank company selector or internal error is shown.

**Evidence:**

- Screenshot of anonymous `/assess`.
- Screenshot after clicking start.

### UAT-ASSESS-02: Company readiness assessment runs during onboarding

**Purpose:** Validate the company-wide assessment path used by onboarding.

**Preconditions:**

- Founder is signed in and has a company.

**Steps:**

1. Open `/assess?onboarding=1`.
2. Confirm it starts in company assessment mode without showing mode chooser.
3. Answer the company assessment prompts using the standard business scenario.
4. Continue through adaptive clarifying questions until the assessment is ready.
5. Confirm the app finalizes and redirects back to `/cos`.

**Expected:**

- Onboarding assessment skips the mode chooser.
- Questions are adaptive and relevant.
- A finalizing status appears before redirect.
- User returns to CoS conversation.
- CoS phase advances based on the crystallized assessment.

**Evidence:**

- Screenshot of company assessment.
- Screenshot of finalizing state.
- Screenshot of return to `/cos`.

### UAT-ASSESS-03: Project assessment creates downloadable output

**Purpose:** Validate the non-onboarding assessment entry point still works for a newly onboarded user.

**Steps:**

1. Open `/assess`.
2. Choose project-specific assessment.
3. Enter project:
   - Name: `Pilot Onboarding Automation`
   - Goal: `Reduce founder time per pilot onboarding below 2 hours`
   - Timeline: `90 days`
   - Current state: `Manual checklist and customer email follow-ups`
4. Answer clarifying questions.
5. Run the project assessment.
6. Download the generated Word document if the button appears.
7. Return to `/assess` and verify the project appears in past project assessments.

**Expected:**

- Project assessment accepts concise intake.
- Clarifying questions are relevant.
- Assessment result is readable and specific to the project.
- Downloaded document opens and contains the assessment content.
- Stored assessment appears in history/list.

**Evidence:**

- Screenshot of result.
- Filename of downloaded `.docx`.
- Screenshot of stored project assessment list.

## 5. Feature 4: Free/Pro Billing

### UAT-BILL-01: Free tier status is visible after onboarding

**Purpose:** Validate that a new workspace starts with visible billing state.

**Steps:**

1. As founder, open `/billing`.
2. Observe plan status, seat count, and primary action.

**Expected:**

- Page loads without requiring Stripe checkout first.
- Plan is shown as `free` unless test setup preconfigured a Pro state.
- Seats paid is shown.
- **Start Pro trial (14 days, no card)** is visible for Free state.

**Evidence:**

- Screenshot of Billing page.

### UAT-BILL-02: Free tier blocks extra human invite with upgrade prompt

**Purpose:** Validate onboarding invite caps on Free.

**Preconditions:**

- Workspace is on Free tier.
- Founder is the only human member.

**Steps:**

1. Try to invite a second teammate from the onboarding invite card or `/company/settings/invites`.
2. If an invite is allowed because local trusted mode bypasses caps, note that as environment behavior and rerun in authenticated/staging.
3. Observe response or UI prompt.

**Expected:**

- In cap-enforced environments, inviting a second human returns an upgrade-required state.
- User sees a clear upgrade prompt, not a generic error.
- Existing workspace remains usable.

**Evidence:**

- Screenshot of upgrade prompt or error.
- Network response if available; expected code is payment/cap related, not 500.

### UAT-BILL-03: Free tier blocks extra agent hire with upgrade prompt

**Purpose:** Validate agent cap when onboarding tries to add beyond Free allowance.

**Preconditions:**

- Workspace is on Free tier.
- Workspace already has one agent if Free cap counts the CoS as the one included agent.

**Steps:**

1. In `/cos`, confirm a plan that would add at least one direct-report agent, or open `/agents/new`.
2. Attempt to create the additional agent.
3. Observe error handling.

**Expected:**

- In cap-enforced environments, extra agent creation is blocked with upgrade-required messaging.
- Error explains the cap and route to Pro.
- No partial agent is left behind on failure.

**Evidence:**

- Screenshot of blocked create/hire path.
- Screenshot of `/agents/all` showing no unexpected partial agent.

### UAT-BILL-04: Start Pro trial and return from Stripe

**Purpose:** Validate Stripe checkout/portal loop for onboarding expansion.

**Preconditions:**

- Stripe test mode is configured.
- Webhook forwarding is active if local.

**Steps:**

1. Open `/billing`.
2. Click **Start Pro trial (14 days, no card)**.
3. Complete Stripe test checkout.
4. Return to AgentDash.
5. Wait up to 10 seconds for webhook polling.
6. Refresh `/billing`.

**Expected:**

- User is sent to Stripe test checkout.
- Return URL lands back in Billing.
- Toast or status indicates trial activation.
- Plan changes to `pro_trial` or equivalent Pro state.
- User can now invite teammates and hire additional agents.

**Evidence:**

- Stripe checkout screenshot.
- Billing page after return.
- Any webhook log lines.

### UAT-BILL-05: Manage subscription path opens portal

**Purpose:** Validate post-upgrade billing control.

**Preconditions:**

- Workspace is in Pro trial or active state.

**Steps:**

1. Open `/billing`.
2. Click **Manage subscription**.
3. Confirm Stripe portal opens.
4. Return without making destructive subscription changes unless testing downgrade.

**Expected:**

- Portal session opens in Stripe test mode.
- No AgentDash error appears.

**Evidence:**

- Screenshot of portal page.

## 6. Feature 6: CoS Onboarding + Invites

### UAT-INV-01: Invite card generates durable links

**Purpose:** Validate invite generation from CoS onboarding.

**Steps:**

1. In `/cos`, proceed until an invite prompt card appears, or ask CoS: `Invite my teammate to this workspace.`
2. Enter two comma-separated emails:
   - teammate test email
   - second teammate test email
3. Click **Send invites**.

**Expected:**

- Invite prompt accepts comma-separated emails.
- Generated invite links remain visible after send.
- Each invite row shows email status: sent, skipped, or failed.
- Copy link button works.
- If email provider is not configured, `Email not sent`/skipped is acceptable as long as the link is shown.

**Evidence:**

- Screenshot of generated invite links.
- Copied invite URL for the teammate test user.

### UAT-INV-02: Invite acceptance preserves company and onboarding context

**Purpose:** Validate invite landing and membership creation.

**Steps:**

1. Open the copied invite URL in a clean browser profile.
2. Create or sign into the teammate account matching the invite email.
3. Accept the invite.
4. Open `/cos`.
5. Verify the teammate can read the onboarding context.

**Expected:**

- Invite page shows company name and inviter details.
- Teammate can accept without seeing an unrelated company setup path.
- Teammate joins the same company.
- Teammate lands in or can access the same CoS conversation.

**Evidence:**

- Screenshot of invite landing.
- Screenshot of teammate in `/cos`.

### UAT-INV-03: Existing account accepts invite safely

**Purpose:** Validate invite handling for users who already have an account.

**Preconditions:**

- Existing teammate account exists with the invited email.

**Steps:**

1. Open a new invite URL for that email.
2. Choose existing-account sign-in path.
3. Sign in with matching account.
4. Accept the invite.

**Expected:**

- UI guides user to sign in with the matching email.
- Invite cannot be accepted with a mismatched account.
- Accepted invite adds membership to the intended company.

**Evidence:**

- Screenshot of existing-account path.
- Screenshot of final company access.

## 7. Feature 7: Goals / Eval / HITL in Onboarding

### UAT-GOAL-01: Onboarding creates traceable company goals

**Purpose:** Validate that captured onboarding goals become first-class goals.

**Steps:**

1. Complete CoS planning and click **Set it up**.
2. Open `/goals`.
3. Open the goal that matches the short-term onboarding goal.
4. Inspect title, description, status, owner, and activity.

**Expected:**

- At least one company-level goal exists from onboarding.
- Long-term and short-term goals are represented clearly.
- Duplicate goals are not created if **Set it up** is retried once.
- Activity log shows goal creation or onboarding materialization.

**Evidence:**

- Screenshot of `/goals`.
- Screenshot of goal detail.

### UAT-GOAL-02: Starter project and issue inherit onboarding goal context

**Purpose:** Validate that first work item is connected to the user's onboarding goals.

**Steps:**

1. From the completed onboarding state, open `/projects`.
2. Open the starter/default project if created.
3. Open the first issue/task created from onboarding.
4. Check goal links, project links, and issue context.

**Expected:**

- Starter work traces back to the selected/materialized onboarding goal.
- Issue title/body is specific to the onboarding scenario.
- Agent assignment, if present, matches the proposed plan.
- There is no orphan task that lacks company/project/goal context when one should exist.

**Evidence:**

- Screenshot of project overview.
- Screenshot of issue detail with goal/context visible.

### UAT-GOAL-03: Definition of Done gate is visible and editable

**Purpose:** Validate user-facing evaluation setup after onboarding.

**Steps:**

1. Open a project or issue created during onboarding.
2. Navigate to configuration/details area where Definition of Done appears.
3. Add DoD summary:
   `Pilot onboarding path works for three customers with under two founder hours each.`
4. Add criteria:
   - `Three pilot customers imported`
   - `Each pilot has checklist and document request workflow`
   - `Founder time is measured`
5. Save.

**Expected:**

- DoD editor is visible where a user would expect it.
- Criteria save successfully.
- Validation catches blank/invalid criteria.
- Saved DoD persists after refresh.

**Evidence:**

- Screenshot before and after save.

### UAT-GOAL-04: Human review / verdict surfaces do not block onboarding unexpectedly

**Purpose:** Validate HITL surfaces are understandable to a new user.

**Steps:**

1. Open any issue associated with onboarding.
2. Trigger or inspect available review/verdict cards if present.
3. If a verdict review or human taste gate appears, read the copy and available actions.
4. Attempt a safe action such as approving, passing, or leaving a comment only if it is clearly reversible in the test environment.

**Expected:**

- Verdict/HITL cards explain what needs human input.
- User can distinguish "needs review" from "agent failed."
- Onboarding task remains accessible even if review is pending.
- No raw internal enum-only UI is shown.

**Evidence:**

- Screenshot of any verdict/HITL card.
- Notes on any unclear wording.

## 8. Feature 8: Deep-Interview Engine

### UAT-DI-01: Deep interview asks adaptive, bounded questions

**Purpose:** Validate Socratic clarification during onboarding assessment.

**Steps:**

1. Open `/assess?onboarding=1`.
2. Answer the first prompt vaguely:
   `We want AI agents to help operations.`
3. Continue answering with partial but useful detail.
4. Track the number and quality of follow-up questions.

**Expected:**

- Follow-ups target missing dimensions: goal, constraints, criteria, and context.
- Questions are specific and non-repetitive.
- The flow does not ask endless questions.
- The system eventually reaches a ready/finalizing state or gives a clear fallback.

**Evidence:**

- Copy/paste or screenshot of each question and answer.
- Count of rounds before ready state.

### UAT-DI-02: Deep interview crystallizes and hands off to CoS

**Purpose:** Validate transition from interview state to onboarding state.

**Steps:**

1. Complete UAT-DI-01 until the assessment reaches ready/finalizing.
2. Wait for redirect to `/cos`.
3. Ask CoS: `What did you learn from the assessment?`
4. Review the answer.

**Expected:**

- App redirects to `/cos` after finalization.
- CoS references the goals/constraints from the deep interview.
- No duplicate or stale interview state is visible.
- Refreshing `/cos` preserves the handoff context.

**Evidence:**

- Screenshot of finalizing state.
- Screenshot of CoS answer referencing the assessment.

### UAT-DI-03: Deep interview handles refresh/resume

**Purpose:** Validate a user can leave and return mid-interview.

**Steps:**

1. Start `/assess?onboarding=1`.
2. Answer one or two questions.
3. Refresh the browser.
4. Continue the flow.

**Expected:**

- User can continue without losing all prior context, or the UI clearly restarts with no broken state.
- No duplicate finalization happens if the user refreshes near the ready state.
- If finalization was already completed, revisiting the URL does not create a second spec for the same conversation.

**Evidence:**

- Screenshot after refresh.
- Notes on whether resume or graceful restart occurred.

## 9. Cross-Feature Happy Path

### UAT-E2E-01: Full onboarding journey

**Purpose:** Validate the onboarding story as a user would experience it.

**Steps:**

1. Founder signs up.
2. Founder lands in CoS-led setup.
3. Founder completes `/assess?onboarding=1` if routed there.
4. Founder answers CoS goal/planning questions.
5. Founder revises the proposed plan once.
6. Founder confirms the plan.
7. Founder verifies agent(s), goal(s), and starter work exist.
8. Founder sends teammate invite.
9. Teammate accepts invite in a second browser profile.
10. Teammate posts in `/cos`.
11. Founder sees teammate message.
12. Founder opens `/billing` and confirms current plan.
13. If Stripe test mode is configured, founder upgrades to Pro trial.
14. Founder reruns invite/agent-create action that was previously capped.

**Expected:**

- The full journey is understandable without reading docs.
- Every major transition has clear feedback.
- No duplicate companies, conversations, goals, or agents are created by normal reload/back-button usage.
- The new teammate shares the same workspace and CoS conversation.
- Billing state matches the user's ability to invite/hire.

**Evidence:**

- One screenshot per major stage.
- Final list of created company, agents, goals, and invitees.
- Any issue links filed for failures.

## 10. Issue Filing Template

Use this for each UAT failure:

```markdown
## UAT failure

Script: UAT-...
Environment:
Git SHA / release:
User:
Company:
Browser:

## Expected

...

## Actual

...

## Steps to reproduce

1.
2.
3.

## Evidence

- Screenshot:
- Network response:
- Console error:
- Server log excerpt:

## Severity

- Blocker: prevents new user onboarding
- High: user can onboard only with workaround
- Medium: confusing or partial feature failure
- Low: copy/visual/polish issue
```

## 11. Pass / Fail Summary

| Script | Result | Notes / Issue |
| --- | --- | --- |
| UAT-ONB-01 |  |  |
| UAT-ONB-02 |  |  |
| UAT-ONB-03 |  |  |
| UAT-ONB-04 |  |  |
| UAT-CHAT-01 |  |  |
| UAT-CHAT-02 |  |  |
| UAT-CHAT-03 |  |  |
| UAT-ASSESS-01 |  |  |
| UAT-ASSESS-02 |  |  |
| UAT-ASSESS-03 |  |  |
| UAT-BILL-01 |  |  |
| UAT-BILL-02 |  |  |
| UAT-BILL-03 |  |  |
| UAT-BILL-04 |  |  |
| UAT-BILL-05 |  |  |
| UAT-INV-01 |  |  |
| UAT-INV-02 |  |  |
| UAT-INV-03 |  |  |
| UAT-GOAL-01 |  |  |
| UAT-GOAL-02 |  |  |
| UAT-GOAL-03 |  |  |
| UAT-GOAL-04 |  |  |
| UAT-DI-01 |  |  |
| UAT-DI-02 |  |  |
| UAT-DI-03 |  |  |
| UAT-E2E-01 |  |  |
