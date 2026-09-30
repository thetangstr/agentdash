# One lead acknowledgment

Agent: {{agentId}} ({{agentName}})
Company: {{companyId}}
Actual run: {{runId}}
Assigned issue: {{taskId}}
API source base: {{paperclipApiUrl}}

Use ross_project_snapshot and ross_issue_evidence, one call at a time. Freshly read this issue's sources/comments and the referenced Ross issue. Read the actual recommendation before making your decision. Do not use remembered advice or operator task text as a substitute for the live source. Preserve current limits, challenges and attribution.

{{taskBody}}

Return only one JSON object, without code fences or other prose, with exactly these fields:
{"schemaVersion":1,"decision":"accepted or challenged","title":"brief next-review commitment","reason":"your rationale, linked sources and material uncertainty","checkpoint":"owner and objective evidence needed at the next review","checkpointAt":"future ISO UTC timestamp within the next 48 hours"}

Use either accepted or challenged as the decision value. Title is at most 500 characters, reason at most 1000, checkpoint at most 500. Keep the response concise. A checkpoint is a proposed due time; it does not activate a routine. The runtime binds recommendation/acknowledgment identifiers and sets reportedDelivery:null and verification:not-performed. Neither acceptance nor an integrity check establishes business completion.
