# Company Evaluator — Milestone 5 shadow run (runbook and calibration protocol)

Status: prepared 2026-09-06; the run starts on the founder's word. Stage 1
stays read-only throughout: the evaluator records and escalates, it changes
nothing. Nothing in this document activates enforcement.

## 1. What the run must produce

From the mandate, verbatim in substance: the evaluator scores **two
consecutive real milestones** in shadow mode; its findings are compared with
independent human or founder review; false positives, false negatives,
disagreement reasons, missing telemetry and cost are recorded; and the
graduation criteria are each measured and reported, ending in a recommendation
(remain read-only, revise, or propose a specific enforcement policy).

The report route measures the criteria; the humans supply the verdicts. See §5.

## 2. Candidate milestones (D3, founder to confirm)

Company **Agent Runner** (`ff60936e-fd79-4a34-98ae-02e5e7a07250`, prefix AGE)
on the local instance execos-local.

| candidate | ref | why |
|---|---|---|
| **MVL 1.0 Launch** | project `e21af1b7` | the real, in-progress product milestone; lead Priya; its work already flows through the MAW handoffs the evaluator reads |
| **Company Evaluator build** | project `3313d8d1` (goal `3c58a6a2`) | the second consecutive milestone; has declared acceptance criteria on the board so O1 is measurable there; the evaluator scoring the project that built it is the strongest test of rule 12 (its own items are excluded) |
| Design-Partner Learning and GTM Readiness | project `84499c19` | alternative second milestone; fewer structured records, so more classes stay undecidable |

Recommendation: MVL 1.0 Launch first, the evaluator build second. Both are
projects, so the cadence covers them; goals are snapshotted by an
administrator when wanted.

## 3. Bringing the instance onto main (owner: founder or the ota lane)

execos-local runs the local-only branch `ota/integration-mkthink` of the
checkout `/Volumes/mac_studio_ssd/Projects/agentdash-ota-integration` and must
not be detached to main. A merge candidate is prepared:

- branch `ota/integration-mkthink+main-20260906` in the repository the ota
  checkout belongs to (the primary AgentDash clone in the founder's home
  directory; its worktree directory `.claude/worktrees/ota-merge` merely sits
  under the mac_studio tree), one merge commit bringing `origin/main` at `aa35d1b82`
  (v2026.904.0 plus evaluator Milestones 1–4 and follow-ups) into the ota
  branch, upstream-preferred on twelve conflicts: migration journal 0124–0127,
  `agent_api_keys.principal_kind`, codex command fallback in the adapter
  registry (one duplicate declaration removed), instruction-refresh
  suppression fast path, hermes execute env-envelope tests, `agents.ts`
  evaluator key helpers, bridge command name test, ConnectYourMachine egress
  flag, sandbox and customer-doc wording.
- verified there: `pnpm -r typecheck` clean; hermes execute, bridge command
  name, evaluator gate, evaluation routes and card-contract suites 43/43; the
  full server suite run is recorded in the M5 status when it finishes.

**Before the run:** the records and the report in §5 and §6 land with the
Milestone 5 preparation pull request. Once it is merged, the merge candidate is
refreshed from `origin/main` again (same procedure, fewer conflicts) so the
instance carries them; a §3 deploy from the candidate as first prepared would
answer §5 with "Invalid disposition" and §6 with 404.

Steps (each reversible):

1. Back up the instance database: from `cli/`,
   `pnpm --silent exec tsx src/index.ts db:backup -c ~/.execos/agentdash-local/agentdash-home/instances/execos-local/config.json --json`.
   Note the file under `data/backups`.
2. In the ota checkout: `git merge --ff-only ota/integration-mkthink+main-20260906`
   (a fast-forward; if it refuses, the ota branch moved — re-merge from it).
3. Restart the instance in tmux `execos-0`, window `agentdash-local`: SIGTERM
   the node listener on 3199, wait for 3199 and 55440 to free, relaunch with
   the standard recipe (`PAPERCLIP_MIGRATION_AUTO_APPLY=true pnpm --silent
   --filter paperclipai exec tsx src/index.ts run -d
   ~/.execos/agentdash-local/agentdash-home -i execos-local --no-repair`, from
   a login zsh). Migrations 0124–0127 apply on start (four, forward-only).
4. Confirm `GET /api/health` and that `GET /api/companies/ff60936e…/evaluation/overview`
   answers with every project and goal of the company listed, each with
   `latest: null`, and `principal.provisioned: false`.

Rollback: `git reset --hard 209017cc` in the ota checkout, restore the backup,
restart.

## 4. Switching the evaluator on (owner: founder; every step audited)

1. Provision the principal as an administrator:
   `POST /api/companies/<co>/evaluation/principal` with `{}`. The response
   carries the evaluator agent, the review-items project id and the key token
   **once** — store it where the evaluator's runs read `PAPERCLIP_API_KEY`
   (the agent's adapter env), never on the board. The provisioning
   administrator becomes the evaluator's accountable human (D12).
2. Set on the instance environment and restart:
   `AGENTDASH_EVALUATION_INGEST_ENABLED=true` (interval default 5 min, floor
   60 s) and `AGENTDASH_EVALUATION_SNAPSHOT_ENABLED=true` (interval default one
   day, floor one hour; `AGENTDASH_EVALUATION_SNAPSHOT_INTERVAL_MS` to change).
3. Backfill the ledger once: `POST …/evaluation/ingest/run?backfill=true`
   (administrator; bounded passes; repeat until `exhausted: true`).
4. Store the first cards by hand rather than waiting a day:
   `POST …/evaluation/scorecards/snapshot?reviewItems=true` with
   `{ "kind": "project", "id": "<milestone>" }` for each candidate. Read the
   response's `verify` (must agree) and `reviewItems` (digests created for the
   accountable humans). Open `/evaluation` and the founder view.
5. Declare the contract for each milestone where criteria exist
   (`POST …/evaluation/contracts`, administrator; v1 schema) so O1 stops being
   insufficient by construction. Until then the cards say "contract derived by
   the evaluator — confidence capped at adequate", which is the honest state.

The evaluator agent itself (Hermes profile as the other agents) runs only on
exceptions: it is woken by the cadence's review items, reads the card and the
events, and writes findings and correction notes through its allowlisted
routes. It needs no schedule of its own. If it is not run at all, every
criterion except "evaluation model cost" is still measured; cost then reads
$0.00, which is true and should be reported as "not exercised".

## 5. Calibration protocol (the humans' part)

Per milestone, at each stored version that a human reviews:

1. **Every immediate and material exception** on the card gets a verdict:
   `POST …/evaluation/dispositions` with `kind: "exception_reviewed"`,
   `milestoneRef`, `exceptionKey` (from the card), `verdict: "confirmed" |
   "false_positive"`, and a `reason` in words. Routine exceptions are reviewed
   when time allows; they do not enter precision and recall.
2. **Anything the reviewer would have raised and the card did not** is filed
   with `kind: "exception_missed"` (title, severity, description, optional
   event ids). Every miss is discussed at the milestone review.
3. **Disputes** go through the ordinary correction flow (§9.4): the human files
   a correction, the evaluator may attach a cited note, a manager or the
   founder decides, an administrator records `correction_decided`. Rejected
   corrections stay visible on the founder view.
4. **Rescues, missing telemetry, disagreement reasons and cost observations**
   are filed as `kind: "shadow_note"` with the matching topic. A rescue is any
   act by the founder that ordinary engineering or product flow should have
   handled; recording one is what makes the "no rescues" criterion honest.
5. The reviewer is independent of the evaluator (any human; not the evaluator
   agent) and independent of the item's own contributors where possible.

## 6. Reading the report

`GET …/evaluation/shadow-report?refs=project:<id>,project:<id>&costCapCents=<cap>&verifyLimit=<n>`
(administrator; the same milestone may not be named twice). Per milestone:
stored versions and how many were replayed (newest first, twenty by default)
with agree, disagree and older-formula counts; exceptions raised over the whole
run with the share of material ones that cite events, and the latest card's
split; verdict counts on material and immediate exceptions with precision and
recall, plus routine reviews, unknown keys and the reasons given for false
positives; review-item digests per human and immediate items; the notes by
topic. Company-wide: corrections pending, accepted, rejected and evaluator
notes; evaluator runs, metered cost events and cost; what the evaluator did
with its authority (refused attempts, writes outside its allowlist, whether it
is scored on any card, whether its review project was named as a milestone);
queries that reached the read cap. Then the seven graduation criteria, each
`met`, `not_met` or `not_measurable` with the measured words.

Rules of reading: a `not_measurable` is not a pass; older-formula versions are
counted, not compared; cost is per company because the evaluator's runs carry
no milestone tag, and an evaluator that never ran, or ran unmetered, cannot pass
the cost criterion; the cap is the founder's to set and is passed on the query.

## 7. End of the run

When both milestones are closed: generate the report with the cap, attach the
notes, and write the recommendation the mandate asks for — remain read-only,
revise, or a specific enforcement policy — with the measured criteria beside
it. Enforcement is not activated by anything in this document; that is a later
stage on the founder's explicit word.

## 8. Known gaps going in

- No Playwright pass over a live server yet (AGE-104); the contract fixture and
  route tests carry the M4 acceptance until then.
- Rule 14 (bundling) and rule 18's inheritance clause are unimplemented and
  recorded; neither affects the criteria above.
- Cards stored before m2-score/7 report "formula changed" on verify until
  re-snapshotted; the first snapshot after deployment is the baseline.
