# The prompt Titus pastes into Claude Code or Codex

This used to be ten kilobytes of endpoints and traps. That was a design failure,
not a deliverable: every line of it was product knowledge that the customer was
being asked to carry, re-typed into every prompt, and wrong the moment the API
moved.

All of it now lives in the MCP server's operating playbook, which the harness
loads automatically on connect (`packages/mcp-server/src/playbook.ts`, the
"Standing up a company" section). So the prompt is what a prompt should be: one
command to connect, and a person describing what they want.

---

## Step 1 — connect (once)

```
claude mcp add agentdash \
  --env PAPERCLIP_API_URL=http://192.168.86.57:3102 \
  --env PAPERCLIP_API_KEY=pcp_board_c4b678e7713733d06fc791deeb29c1034eb0f8d10c0f00ec \
  -- npx -y http://192.168.86.57:3102/downloads/agentdash-mcp-server.tgz
```

Restart the harness so the tools load. Codex users put the same four values in
`~/.codex/config.toml` — the My Agent page prints that form too.

## Step 2 — say what you want

```
Set up my company in AgentDash and then run the first piece of work.

MKThink is an architecture and planning firm. We use data and analytics to help
institutional clients — schools, districts, campuses — decide what to build and
where, before design starts. My workspace code is MK-LANTEST.

I want a Chief of Staff that is my own agent and also the company's, plus one
agent each for three of my leads:

  Priya — live client projects, and which commitments are at risk
  Raj   — the SharePoint estate and our repositories
  Maya  — recruiting, and who is waiting on us

Invite all three so they can sign in and collect their own agent's key.

Three rules across every agent: Raj's agent must never delete anything — it
proposes a list for him to approve; no agent contacts a client or a candidate
directly, they draft and a person sends; no agent reports a number it cannot
source.

Then set our first goal — a weekly board pack I can ask for once instead of
chasing for two days — and actually run it: have the Chief ask each agent for its
part and assemble the pack, attributed.

Ask me anything you need. Don't invent names, emails or numbers.
```

That is the whole prompt. The playbook supplies the sequence and every trap:
profile and code in one request, AGENTS.md rather than directives, making me the
steward of my own agent, invites that return links rather than sending mail,
pairing that waits on acceptance, the key arriving in `token`, `goalId` on every
task, the five required fields on a fact request, and the agent-only routes that
correctly refuse my key.

## What "working" looks like

The pack will come back with gaps, and that is the pass condition. Those agents
have no connectors yet — they genuinely cannot read SharePoint, HubSpot or the
project tracker. The playbook tells them a truthful "I cannot source this, here
is what I would need" is the successful outcome.

**If the deck comes back full of confident figures, that is the bug**, and it is
the most useful thing this test can surface.

Expect each agent reply to take 20–110 seconds on an instance using the local CLI
adapter. See the walkthrough's adapter table before assuming something hung.
