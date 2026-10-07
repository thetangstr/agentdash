# Run page: the Business view

The run page (`/agents/:agentId/runs/:runId`) has three transcript views: **Business** (the default), **Readable**
and **Raw**. Business shows one of two things, chosen from data and the same for every company:

1. **A milestone timeline**, when a harness has posted one for the run (below). The page shows the six deal stages
   (Discover, Proposal, Negotiation, Agreement, Execution, Settlement) with the agent's events, the SIMULATED /
   "Stripe TEST mode" labels, inferred stages, refusals, the Clockchain status, and a "Log line n" link from each
   event to that line in the Raw view.
2. **A plain summary** of AgentDash's own transcript, when no timeline was posted. This is what most runs show: what
   the agent did, what it said, the result, how the run ended and what it cost. It never invents stage labels.

A viewer who picks another view keeps it: the choice is stored per browser under `localStorage`
`agentdash.runTranscriptMode` (`business` | `readable` | `raw`). A first-time viewer gets Business. The issue chat's
run blocks offer Readable and Raw only, and show a Business choice as Readable.

## For harness authors: how to post a timeline

The timeline is the `ac.milestone-timeline/v1` JSON (`RunTimeline` in the ac_travel_mvp repo,
`src/lib/agent-pairing/milestones/timeline.ts`; contract in `docs/travel-mvp/design/MILESTONE-TIMELINE.md`, section
"AgentDash business log view: contract"). Post it as an **issue document** on the run's issue. No new endpoint is
involved.

```http
PUT /api/issues/{issueId}/documents/milestone-timeline-{heartbeatRunId}
Authorization: Bearer <the issue's assignee agent key, or a board session>
Content-Type: application/json

{
  "title": "Business log: <RunTimeline.label>",
  "format": "markdown",
  "body": "```json\n{ ...RunTimeline JSON... }\n```",
  "changeSummary": "Milestone timeline for run <heartbeatRunId>"
}
```

- **`issueId`**: `agentdash.issueId` (a UUID). The issue key (`ROM-12`) also works.
- **Key**: `milestone-timeline-` followed by the AgentDash heartbeat run id in lower case
  (`milestone-timeline-5b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6`). That is 55 characters, within the document-key rule
  (`[a-z0-9][a-z0-9_-]*`, at most 64). There is one document per run, so a re-run never overwrites an earlier
  run's timeline. A second `PUT` to the same key is an update: it must carry
  `"baseRevisionId": "<latestRevisionId from GET /api/issues/{issueId}/documents/{key}>"` (otherwise 409
  "Document update requires baseRevisionId"). It adds a revision, and the page shows the latest one.
- **`format`** must be `"markdown"`, the only document format. `body` is the JSON, either bare or (preferred) inside
  one fenced `json` block, so the issue's Documents tab stays readable. The body limit is 512 KiB.
- **Join keys**: include `agentdash: { companyId, agentId, heartbeatRunId, issueId }` at the top level. The page also
  accepts it under `agency.agentdash`. When `heartbeatRunId` or `companyId` is present and does not match the run, the
  page ignores the document.
- **Who may write**: the issue's assignee agent (its own API key), an agent with a checkout-management override, or a
  board user. These are the normal issue-document rules.
- **When**: at run end. While the run is live, the page re-reads the document every 15 s, so a document posted
  mid-run appears without a reload.

### What the page reads

| Field | Use |
|---|---|
| `schema` | Must be `ac.milestone-timeline/v1` (or `v1.x`). Any other major version is not rendered, and the page shows the plain summary with a note. |
| `events[]` with `lane: "agency"` | Listed under their `milestone`, in the order given. |
| `events[]` with `lane: "traveler"` | Folded under "What the other side did" in each stage. |
| `event.milestone` | One of the six taxonomy values. Events with an unknown milestone are skipped and counted. |
| `event.kind`, `summary`, `ts`, `outcome` | Shown. `refused` and `error` are flagged. |
| `event.basis` | `inferred` gets a dashed outline and "stage inferred". |
| `event.simulated` | Shown verbatim as a label on the event and in a banner. It is never dropped. |
| `event.detail` | Behind a "More" disclosure. |
| `event.source.ref` | `seq=<n>` becomes a "Log line n" link to the run-log row with that `seq` (`GET /api/heartbeat-runs/:id/log`), opened in the Raw view. |
| `milestones[].log.status` | Shown per stage ("Clockchain: not logged yet", "Clockchain: anchored"). `ledgerId`/`blockHeight` (or `block`) are shown when present. |
| `clockchain.existingAnchors[]` | Listed under their stage with ledger id and block. |
| `honesty[]` | Under "About this log". |
| `label` | Heading. |

The page ignores fields it does not know, so additive v1 fields are safe. AgentDash never calls Clockchain and never
edits the document.

## Code

- `ui/src/lib/milestoneTimeline.ts`: document key, parser and validator.
- `ui/src/lib/businessSummary.ts`: the plain summary, built on the Readable model.
- `ui/src/components/transcript/BusinessTranscript.tsx`: the view.
- `ui/src/pages/AgentDetail.tsx` (`LogViewer`): fetches the document and links log lines into Raw.
- `ui/src/hooks/useLiveAutoFollow.ts`: live auto-follow for all three views.
