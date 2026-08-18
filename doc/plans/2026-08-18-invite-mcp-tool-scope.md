# Scope: a human-credential invite tool for MCP

Date: 2026-08-18
Status: scoped, not started
Prerequisite: PR #477 merged (`2d99f5389`)

## The problem this solves

Titus wants to invite Sam, Meg and the rest by asking for it in the chatbot they
already have open, rather than clicking through the Company → Invites page. Today
that request fails, and it fails correctly: an agent-authenticated caller hitting
the invite route is refused by `server/src/routes/access.ts`:

> `Agents cannot invite people. Ask an admin to send the invite.`

That refusal is not an oversight to route around. The comment above it records
why: after the 2026-08-16 role collapse, the lowest human role is `member`, and
`member` carries write authority. There is no read-only tier left to hand out, so
an agent minting an invite is a privilege-escalation path with a person in the
middle. **This feature must not weaken that check.**

## What this feature is, precisely

Not new capability — ergonomics with guardrails. A board-key session can already
invite today through `api_request`, the MCP escape hatch that will make any
`/api` call the caller's credential permits. But that path requires knowing the
route and body shape, accepts any `role` the server will take, and reads in an
audit trail as an anonymous API call. A named tool is the difference between a
capability that exists and one a person can actually reach — the same gap that
made "renaming an agent doesn't work" get filed as a bug when `PATCH /agents/:id`
had always worked.

## What makes it possible without weakening anything

`server/src/middleware/auth.ts` resolves three actor types: `agent`, `board`,
`none`. A *board API key* — looked up by `boardAuth.findBoardApiKeyByToken` —
produces `actor.type === "board"` carrying a real `userId`, that person's
company memberships, and their `isInstanceAdmin` flag.

So the invite route already permits exactly the caller we want. Nothing in the
server needs to change. What is missing is only an MCP tool, and the discipline
about which credential it may run under.

## Design

One new tool in `packages/mcp-server/src/tools.ts`, alongside the existing
`makeTool(name, description, schema, handler)` definitions:

```
agentdashInviteTeammate({ companyId?, email, name? })
  → { inviteUrl, expiresAt, role: "member", emailDelivered: boolean }
```

Rules the tool enforces on its own side, before any HTTP call:

1. **Board credential only.** If the configured key resolves to an agent actor,
   refuse locally with a message naming the fix ("this session is authenticated
   as an agent; configure a board API key belonging to a person"). Do not let the
   server's 403 be the first thing the model sees — a model that meets a 403
   tends to retry creatively.
2. **No `role` parameter at all.** The role is hard-coded to `member`. A tool
   that cannot express `owner` cannot be talked into it.
3. **Returns the link, always.** Email delivery through Resend is best-effort;
   when it is unconfigured or fails, the tool still returns the shareable URL and
   says delivery did not happen. The link is the deliverable, the email is a
   convenience.
4. **Multiple invites in one call are out of scope for v1.** One email per call
   keeps the audit line unambiguous.

Server side: no route changes, no new permissions, no new middleware. If this
feature appears to require any, that is the signal to stop and re-read the
boundary comment.

## Acceptance criteria

- AC-1 A Claude Code session configured with Titus's board API key can create an
  invite for a named email and receives a working URL.
- AC-2 The same session configured with an agent key is refused by the tool
  itself, with a message that names the credential problem.
- AC-3 The created invite always resolves to `member`; there is no input that
  produces any other role.
- AC-4 With no email provider configured, the call still succeeds and reports
  `emailDelivered: false`.
- AC-5 Accepting the returned URL produces an active `member` membership that
  cannot manage invitations — the assertion the existing E2E already makes.
- AC-6 `server/src/routes/access.ts` is unchanged by this work.

## Out of scope

Bulk invites, role selection, revocation-by-chat, and any agent-initiated path.
Revocation stays in the UI for now: it is rare, and it is the one operation where
a mistaken natural-language match is expensive.

## Open question for Titus

Whose board key does the MCP session hold? If it is Titus's own, every invite is
attributed to them, which is right. If it is shared, the audit trail names the
key rather than the person — acceptable for a five-person office, worth revisiting
before this ships to a second customer.
