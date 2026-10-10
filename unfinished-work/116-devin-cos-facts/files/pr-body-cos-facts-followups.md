## Thinking Path

> - #1006 moved the CoS workspace facts into their own user-role message with a per-request nonce delimiter; the final review marked four LOW items as follow-ups
> - A message that arrives after the trigger races the dispatch: the system prompt says "the last message in this chat" but the newest history entry was no longer the trigger — the framing could misidentify which message is being answered. Dropping post-trigger messages keeps the invariant literal; the next dispatch answers them
> - `sanitizePromptData` sanitized string leaves but not object keys, so a goals field named `team\n>>>` could still inject a line break into the prompt JSON
> - `buildFlatPrompt` flattens chat messages into bracketed role-headed text for the CLI adapters; a user-authored line opening with a System/User/Assistant header would read as a forged turn
> - `cosTurnContextMessage` still defaulted to a guessable `workspace-facts` marker; making the parameter required removes any path that could reuse a predictable delimiter

## What Changed

- `server/src/services/cos-replier.ts`: history is truncated at the trigger message before labelling, so raced-in messages never reach the model and the facts message still lands immediately before the answered turn; `cosTurnContextMessage`'s `marker` parameter is now required
- `server/src/services/prompt-fact-text.ts`: `sanitizePromptData` runs object keys through `promptFactText` (60-char cap) as well as string leaves
- `server/src/services/dispatch-llm.ts`: `buildFlatPrompt` (now exported) prefixes any content line starting with a bracketed role header (System, User, or Assistant) with a backslash, in both the system prompt and message bodies
- Tests: a race-case test in `cos-replier-issue-trailer.test.ts` (newer messages dropped, trigger last, facts adjacent), a hostile-key case in the goals sanitization test, and a `buildFlatPrompt` escaping suite in `dispatch-llm.test.ts`

## Verification

- `pnpm -r typecheck`: pass, all workspace projects
- `server` vitest `src/__tests__/cos-` plus `dispatch-llm`, `openai-compat-llm`, `steward-agent-replier`, `conversations-routes`: 22 files, 327 tests, all pass — embedded Postgres on a dynamic port; 54329 untouched
- `pnpm build`: pass
- No route changes, so no API-doc regeneration needed; no worker-prompt change, so the PR title carries the no-prompt-update marker

## Risks

- Dropping post-trigger messages narrows the model's context to turns the requester may not have finished writing; acceptable because the next dispatch re-answers with the complete history
- Backslash-escaped role headers still render the bracketed text to the model, just no longer at line-start as a header; the alternative (zero-width space) hides the escape, so the visible backslash was chosen
- Key sanitization may collide two keys that differ only in control characters; the later value wins, matching how duplicate JSON keys behave

## AgentDash Review

- **Upstream impact:** None — cos-replier, prompt-fact-text and dispatch-llm are AgentDash-owned CoS chat plumbing; no inherited Paperclip surface changes
- **Agent-facing prompt surfaces:** None - this hardens the server-side CoS chat dispatch prompt, which workers never receive; the two prompt surfaces (`onboarding-assets/default/AGENTS.md`, `agent-creator-from-proposal.ts`) are untouched, so the PR title carries the no-prompt-update marker
- **AgentDash-owned subsystem:** CoS chat replier and LLM dispatch layer

## Model Used

- Provider: Cognition
- Model: SWE-2 High (Devin CLI agent); tool use, file editing and shell execution

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have filled out AgentDash Review with upstream impact, prompt-surface impact, and owned subsystem
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [ ] If this change affects the UI, I have included before/after screenshots
- [ ] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] If this is upstream-derived, I have followed `doc/UPSTREAM-POLICY.md` and recorded the upstream SHA/reason/verification
- [x] If this changes agent-facing behavior, I have updated both prompt surfaces (default AGENTS.md and agent-creator-from-proposal.ts) or explained why they do not apply
- [x] I will address all Greptile and reviewer comments before requesting merge
