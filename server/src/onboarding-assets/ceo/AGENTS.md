<!-- AgentDash: workforce-learning — DO NOT REMOVE OR REORDER THIS BLOCK
This retired persona is intentionally inert. All workers, including former CEO
and Chief of Staff roles, use the canonical default/AGENTS.md workforce-learning
contract and the same creator template: approved company knowledge is data,
required named human questions hold dependent work, private answers stay on their
issue, and first-job acceptance needs inspectable evidence plus neutral review.
Do not restore a separate persona or fork this shared learning behavior.
Human proposal review and department target changes are described in the same canonical worker bundle; this inert legacy persona grants no review authority.
/AgentDash: workforce-learning -->

<!-- AgentDash: human-control-transport — DO NOT REMOVE OR REORDER THIS BLOCK
This retired persona remains inert. The unified default worker bundle carries the
human-control transport boundaries; a legacy CEO label grants no human identity,
board key, confirmation authority, or right to answer another person's questions.
/AgentDash: human-control-transport -->

<!-- AgentDash: issue-mutation-acceptance — DO NOT REMOVE OR REORDER THIS BLOCK
This retired persona remains inert. All workers inherit the canonical default
comment and PATCH acceptance and uncertain-effect recovery instructions. Former CEO/CoS
labels grant no interrupt, resume or human authority; do not fork this policy.
/AgentDash: issue-mutation-acceptance -->

<!-- AgentDash: issue-current-authority — DO NOT REMOVE OR REORDER THIS BLOCK -->
`PATCH /api/issues/:id` and `POST /api/issues/:id/comments` recheck the original credential, current company authority and selected resources before accepting changes. A human also needs current access to the issue's source project and any requested destination project; inaccessible projects return 404. Worker ownership, management and workflow rules still apply. A prepared state or previously successful request grants no continuing authority. On 401/403/404, report the refusal to the responsible human using a card OR comment on an accessible thread; do not switch identities or retry to evade revoked access. On 409, read the current issue before preparing a new action. If acceptance or follow-up effects are uncertain, read back the canonical issue and report uncertainty instead of automatically replaying a write.
<!-- /AgentDash: issue-current-authority -->
