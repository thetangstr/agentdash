# AgentDash SMB Workflow Wedge Research - 2026-09-29

## Status

Read-only research artifact for launch discussion. This is not a committed product scope and does not assume a pilot customer exists. The customer segment and pilot access remain unconfirmed. The recommendation includes parallel feasibility tests and customer discovery, followed by consented concierge/sandbox trials before live systems are connected.

## Direct Recommendation

The first hypothesis to investigate is:

**Warm inquiry to qualified meeting/proposal follow-up for owner-led small service businesses.**

AgentDash should prove that an agent team can take a real or realistic inbound business inquiry, learn the company context, ask only the missing questions, draft or send an on-brand reply, schedule the next step, create/update the CRM record, and produce a short evidence packet. The value is not "better ChatGPT copy." The value is a completed revenue operation with receipts.

The hypothesis has inspectable artifacts and actions: an inquiry is qualified, a reply/proposal is created, and an authorized next step is recorded. It applies only to businesses with sufficient incoming inquiries and repeatable qualification/pricing rules. The local steward/harness bridge may contribute company context, review or execution; applicability to the default hosted launch must be verified in the repository before this is promised.

## Evidence Summary

### Demand Evidence

- The Federal Reserve's 2026 Report on Employer Firms, based on the 2025 Small Business Credit Survey, says "reaching customers and growing sales" was the most commonly reported operational challenge for employer firms. Source: https://www.fedsmallbusiness.org/2026-report-on-employer-firms
- U.S. Bank's 2026 small business survey says owners are focused on practical tools that simplify operations, improve cash flow, and reduce payment friction; the survey sample was 1,000 U.S. small business owners with annual revenue up to $25M and 2-99 employees. Source: https://www.usbank.com/business-banking/business-resource-center/small-business-survey.html
- Alignable's 2026 State of Small Business Survey reports finding customers as the top challenge for respondents. Treat this as useful market color, not neutral primary evidence, because Alignable is a vendor/community platform. Source: https://www.alignable.com/forum/2026-state-of-small-business-survey-results
- FreshBooks' 2025 State of U.S. Small Business says customer acquisition remains a top growth challenge, with 47% of surveyed owners saying it is harder than in previous years. Treat as vendor survey evidence. Source: https://www.freshbooks.com/press/releases/freshbooks-2025-state-of-us-small-business
- Salesforce's Small & Medium Business Trends Report, 6th edition, shows common SMB AI use cases include marketing campaign optimization, content generation, automated customer recommendations, and predictive sales forecasting, while concerns include security, insufficient technical expertise, difficulty choosing vendors, and lack of strategy/use cases. Treat as relevant but vendor-biased. Source: https://www.salesforce.com/en-us/wp-content/uploads/sites/4/documents/resources/smb-trends-report-6th-edition_Salesforce.pdf

### Feasibility Evidence

- Gmail API can list message IDs and threads, fetch full message detail, and send messages with scopes such as `gmail.readonly`, `gmail.compose`, or `gmail.send`. Sources: https://developers.google.com/workspace/gmail/api/guides/list-messages and https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
- Google Calendar API can create events with `events.insert`; Google documents using caller-provided event IDs to prevent duplicate event creation after partial failures. Source: https://developers.google.com/workspace/calendar/api/guides/create-events
- Microsoft Graph supports `sendMail`, returning `202 Accepted`, and warns that acceptance does not prove final delivery. It also supports calendar event creation. Sources: https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0 and https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0
- Slack `chat.postMessage` sends messages to channels/DMs with `chat:write`, subject to rate and membership rules. Source: https://docs.slack.dev/reference/methods/chat.postMessage/
- HubSpot's developer platform now uses date-based API versions; the latest docs page observed here was modified September 9, 2026. HubSpot's CRM APIs cover contacts, companies, deals, tickets, and custom objects. Source: https://developers.hubspot.com/docs/api-reference/latest/overview
- HubSpot's 2026-09 changelog says CRM API write validation rules now apply to API writes, which matters for any autonomous create/update flow: agent writes must be prepared to surface validation failures as questions or owner approval needs. Source: https://developers.hubspot.com/changelog/crm-api-write-validation-enforcement

## Three Candidate Workflow Wedges

### 1. Warm Inquiry to Qualified Meeting or Proposal

Target customer:
Owner-led service businesses, small B2B operators, agencies, consultants, local professional services, boutique implementation firms, or founder-led SaaS teams that already receive some inbound interest but lose speed or consistency on follow-up.

Job to be done:
Turn a warm email, form submission, LinkedIn-style lead note, or referral intro into a qualified next step.

Agent team:
- Chief of Staff: validates company context, asks missing questions, and decides whether to proceed, draft, or escalate.
- Sales Development Agent: reads the inquiry, researches the prospect/account, qualifies against ICP, drafts reply, suggests next step.
- Ops Agent: books calendar slot, records CRM/deal, prepares proposal checklist.

Required access:
- Read: email inbox or exported inquiry list, calendar availability, approved sales collateral, pricing/service descriptions, prior proposals, CRM records if available.
- Write with approval: outbound email, calendar invite, CRM contact/deal update, proposal doc.
- Optional: Slack/Teams for owner approval and internal assignment.

Terminal completion proof:
- Inquiry classified with reason.
- Missing questions asked only when needed.
- Reply sent or owner-approved draft produced.
- Calendar event booked or proposed slots sent.
- CRM/contact/deal record created or updated.
- Evidence packet links the source inquiry, used assets, sent reply/draft, event/deal IDs, and unresolved risks.

Primary metrics:
- Median inquiry-to-first-response time.
- Owner minutes per qualified inquiry.
- Percentage of inquiries completed without extra owner correction.
- Meetings booked per 100 warm inquiries.
- Proposal-ready opportunities created.
- Human edit distance or correction count before send.
- Cost per completed qualified follow-up.

Why it is the recommended first wedge:
The surveyed demand is for customer growth and sales broadly; it does not establish that handling warm inquiries is the right job, or that a business has enough inquiries to benefit. Inspectable outputs make this a useful feasibility candidate. Email/calendar/CRM access, pricing rules and the applicable steward bridge must be checked for each pilot.

Risks:
- Cold prospecting can look spammy and is harder to measure early. Keep the first wedge to warm inbound/referral/re-engagement.
- If pricing, qualification criteria, and service boundaries are absent, the agent must ask before sending.
- Email/calendar/CRM permissions must be narrow and revocable.

### 2. Meeting to Completed Follow-Through

Target customer:
Any owner or team lead with too many customer/vendor/internal meetings and weak follow-through.

Job to be done:
Turn a meeting or call note into sent recap, assigned next steps, calendar holds, CRM updates, and follow-up reminders.

Agent team:
- Chief of Staff: confirms outcome and owner-sensitive commitments.
- Ops Agent: turns transcript/notes into tasks, owners, dates, calendar blocks.
- Account/Sales Agent: sends recap, updates opportunity/customer state, prepares next follow-up.

Required access:
- Read: calendar, meeting notes/transcripts, email thread, CRM/project notes.
- Write with approval: recap email, tasks, calendar follow-up, CRM notes.

Terminal completion proof:
- Recap sent or approval-ready.
- Tasks created with owner/date/status.
- Next meeting or reminder scheduled.
- CRM/project system updated.
- Open questions explicitly listed.

Primary metrics:
- Time from meeting end to recap.
- Percentage of meetings with all next steps captured.
- Overdue follow-ups reduced.
- Owner minutes per meeting follow-through.
- Number of forgotten commitments caught.

Why it is viable:
The pain is broad and recurring, and completion proof is concrete. It is less directly tied to immediate revenue than warm inquiry follow-up, but it can apply across sales, operations, customer success, and founder work.

Risks:
- Requires meeting notes/transcripts; without them the agent must infer too much.
- Some commitments are sensitive and should not be sent without owner approval.

### 3. Approved Assets to Finished Campaign Pack

Target customer:
Small businesses with existing assets and offers but inconsistent marketing execution.

Job to be done:
Turn approved company assets into a ready-to-publish campaign pack: email, social posts, landing copy, image brief, audience, schedule, and performance checklist.

Agent team:
- Marketing Agent: produces campaign materials from approved assets.
- Brand/Quality Agent: checks voice, claims, compliance, and asset reuse.
- Ops Agent: schedules/publishes after approval and records performance tasks.

Required access:
- Read: brand guide, website, approved customer proof, old campaigns, product/service docs, asset folder.
- Write with approval: campaign draft docs, email/social scheduling tool, website CMS or task ticket.

Terminal completion proof:
- Campaign brief accepted.
- Copy/assets produced with source citations.
- Compliance/claim check passed or flagged.
- Approval-ready publish packet created.
- Optional scheduled/published artifacts recorded.

Primary metrics:
- Time from brief to publish-ready packet.
- Human revision count.
- Brand/claim violations caught.
- Campaigns shipped per month.
- Cost per publish-ready campaign.

Why it is promising but weaker for first launch:
Marketing is a real SMB pain and AI marketing use cases are common, but output quality is more subjective. Its priority remains conditional on customer pain, usable company assets, actual execution access and independent quality review. A campaign advertised as finished must include usable visual assets when the channel requires them; an image brief alone is not a finished image.

Risks:
- Generic copy will be judged harshly against ChatGPT.
- Without strong company proof and prior examples, the agent may produce polished but useless material.
- Publishing permissions and brand risk require a stronger approval path.

## First Hypothesis Test

Hypothesis:

For owner-led SMBs with recurring warm inquiries, test whether AgentDash reduces owner time and response lag while producing accepted qualification, reply/proposal and next-step results. Required actions, model/tool budget and owner-time targets must be set from a real baseline, with clear evidence of what was executed and what remains a draft.

Start without committed pilot customers; run discovery and feasibility in parallel:

1. Prepare a proposed 30-case synthetic benchmark spanning three company types. Include complete inputs, missing facts, conflicting pricing, tool refusal, duplicate wake/answer and interrupted execution. Use fresh fixtures, separate from Monica holdouts. Synthetic cases measure capability, not customer demand.
2. For each case define the required terminal result before running it. An appropriate question is a successful clarification, but the dependent job is complete only after resolution and delivery. A draft, a provider-accepted send and a delivered message are different states.
3. Exercise the exact model configuration, existing skills/assets, tool access and cost limits intended for customers. Count all model calls, review agents and retries. Use independent human assessment of deliverable quality; model self-grading alone does not prove it.
4. Compare against the owner's current workflow and a competently used ordinary assistant with equivalent company inputs and authorized tools where available. Record differences in automation, retained context and permissions. Do not manufacture an advantage by withholding relevant facts or deliberately weakening the baseline.
5. Prepare 5-8 customer discovery/artifact review sessions as a proposed first round. Ask for the last real painful task, frequency, current time/cost, acceptable result, tool access and desired human involvement. Recruitment/outreach requires explicit authorization; no one has been contacted. Collect recent work examples with consent, rather than treating enthusiasm for a demonstration as purchase evidence.
6. Run consented concierge/sandbox trials using those actual tasks or approved exports. Measure repeat use and accepted outcomes before choosing the first advertised workflow and expanding department templates.

Proposed launch readiness framework, with numeric outcome/cost targets still to be agreed:

- All deterministic company/visibility, authority, source-use and idempotence tests pass. No fabricated material business claims or unauthorized external actions.
- Complete-input cases finish the defined job; missing-input cases ask/resume correctly. Report these separately rather than rewarding silence or counting an unresolved wait as completion.
- Independent reviewers accept the actual deliverables against company-specific standards. Record defects, human edits and correction time.
- Customer trials show meaningful measured time saved or fewer missed tasks; a stated intention to trust a demo is insufficient on its own.
- End-to-end cost and owner effort fit an agreed baseline/price model on repeated tasks. A threshold such as 80%,95% or ten minutes is not an approved target here.
- Department-specific business KPIs remain separate from near-term artifact quality and completion; booked meetings do not prove closed revenue.

## Role Template Implications

The launch feature should not begin with a generic "sales department" promise. It should begin with a role template bundle for a specific workflow:

- Workflow template: `warm_inquiry_to_next_step`
- Roles: Chief of Staff, Sales Development Agent, Operations Coordinator
- Company knowledge: services, pricing, ICP, disqualifiers, proof points, approved claims, tone, calendar rules, CRM stages, proposal rules
- Required questions: asked only when a needed field blocks safe completion
- Durable answers: stored and reused for future inquiries with source/confidence
- Completion evidence: source inquiry, facts used, actions taken, artifacts created, approvals requested, unresolved blockers
- KPI dashboard: response time, owner minutes, completion rate, correction rate, meetings/proposals created, cost per completed opportunity

## Discussion Choices

Founder decisions still needed:

1. First customer slice: owner-led B2B services, local professional services, small agencies/consultancies, or founder-led SaaS?
2. First source channel: Gmail/Outlook inbox, website form export, HubSpot, Slack, or manual CSV/sandbox?
3. Autonomy line: draft-only, approval-before-send, or send within pre-approved low-risk templates?
4. First proof promise: faster inquiry response, more meetings booked, fewer missed follow-ups, or less owner admin time?
5. Launch bar: synthetic benchmark only, concierge trials, or live pilot before public launch language?

## Caveats

- The transcript mention of "Muse/MetaMuse" is ambiguous. This artifact does not make claims about that competitor.
- Vendor surveys are directionally useful but biased toward their product categories. The strongest neutral demand evidence here is the Federal Reserve Small Business Credit Survey.
- Public API documentation shows possible integrations, not an installed AgentDash connector or an authorized customer tool. Existing execution paths and default-hosted availability must be verified separately. Quality must be proven through actual completion, human correction time and department outcomes.
- Email sending and CRM writing are sensitive. Early launch should default to owner/steward approval before external sends or material CRM changes.



## Parent synthesis of evidence limits

The Federal Reserve report also identifies accuracy and adapting tools to business needs as common challenges among AI users. Its findings come from a nationwide convenience sample of6,525 employer firms (1-499employees), not a random sample or a warm-inquiry study. This supports investigating quality and company fit, while leaving the precise workflow/customer choice open. The U.S.Bank survey is commercial primary research with a different sample; percentages should not be blended as if the surveys measure the same population. Neither survey establishes willingness to buy AgentDash.


## New founder candidate: AI workforce onboarding

Kailor suggested agent onboarding or migration as the task itself. Treat **company context to first accepted useful job** as an additional leading hypothesis, with one concrete starter job underneath it. It overlaps the required launch mechanism and can demonstrate company learning, role/skill installation, real capability checks, focused clarification and reviewed completion. A second job must reuse context and answers to demonstrate recurring product value.

The demand evidence supports AI accuracy/customization and adoption friction broadly; it does not validate a standalone onboarding purchase. Test the onboarding hypothesis alongside the earlier concrete business-job candidates. Compare time to first accepted job, human correction minutes, total setup/job cost, false completion claims and second-job reuse. Question counts require a necessity/quality assessment. Marketing, sales and engineering retain different quality standards and department goals.

Migration meaning is pending optional clarification. Existing-agent import, knowledge preparation and business-system migration would have materially different permission, compatibility and completion requirements. Current code capability findings must constrain the starter job; publicly documented email/calendar/CRM APIs are not equivalent to installed autonomous AgentDash support. No implementation or customer outreach has occurred.
