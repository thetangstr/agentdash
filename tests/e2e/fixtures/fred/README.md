# Fred offline runtime evidence

This fixture opens the actual source UI and runs the normal `claude_local` adapter with a deterministic replacement executable. It exercises authenticated task tools, persistent memory, a native question/answer continuation and approval refusals. It does **not** run the Claude product client, a real model, customer work or any external action. A scripted local-board actor is not human review or calibration.

Run from the repository root with Node 22 and already-installed Playwright/Chrome:

```sh
export FRED_SCRATCH_ROOT=/path/to/registered-external-scratch
export FRED_EVIDENCE_DIR=/path/to/new-retained-evidence
TMPDIR="$FRED_SCRATCH_ROOT" \
node scripts/fred-runtime.mjs \
  --scratch-root "$FRED_SCRATCH_ROOT" \
  --port 3491 --db-port 23491 \
  --browser '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --evidence-dir "$FRED_EVIDENCE_DIR" \
  --keep-server
```

The scratch root must exist on registered external storage. Only one isolated PostgreSQL cluster may run; ports 3491, 13491 and 23491 must be free. Fresh allocation requires 30.35 GiB free. The `--reuse-home` recovery option is restricted to the exact previously owned, stopped synthetic fixture home; its marker, UID, paths, configuration, existing companies and terminal runs are checked before application startup. That explicitly authorized recovery class requires 30.10 GiB, limits net growth to 50 MiB, and preserves prior evidence/data. Both classes stop before approaching the protected 30 GiB reserve. No automatic data-directory deletion occurs.

Opening/setup/profile/brief preparation must leave zero jobs. Only the explicit Start discovery UI action starts Fred. A second run follows the real native owner-answer submission and reads previously saved memory.

The frozen `rubric.json` drives checks of the existing native evaluation ingest, replay-verified snapshot and cases API:

| Case | Execution state | Native obligation | Automated acceptance |
| --- | --- | --- | --- |
| Correct persisted report | done, two runs | delivered_on_time | pass |
| Convincing DONE, wrong report bytes | done, one run | delivered_on_time | fail |
| Legitimate approval pending | blocked, one run | blocked_on_person | absent |
| Assigned, never started | todo, zero runs | not_started | absent |
| Report saved, required proof unsupported | done, one run | delivered_on_time | unknown |

The deterministic document hash is proof of those exact saved bytes, not substantive business quality. The unverified case deliberately adds a criterion the native grader cannot verify. Agent claims cannot satisfy it. The approval case retains a pending native approval, receives 403 when attempting self-approval, and performs no downstream action. Every run also receives 403 attempting to create its own evaluation snapshot.

Evidence includes raw sanitized owner/API and agent/tool receipts, run/task/document revision identities, versioned rubric/profile hashes, changed/untracked source hashes, materialized instruction hashes, browser actions/screenshots, replay agreement, storage samples and explicit limitations. Human acceptance, correction effort, real-world use, business outcomes, actual model quality and provider billing remain pending or unavailable. Scripted usage zero is not a provider bill. The inherited Node loopback fence, fresh HOME and fail-fast executable shims are containment for this controlled fixture, **not** a general arbitrary-code host sandbox.

`--keep-server` leaves only the owned synthetic server/process group running for inspection. Read the returned `fixture-location.json` before stopping it. Signal only that recorded process group; never broad-kill servers or PostgreSQL. Preserve the data directory and evidence. Without this flag, the runner stops its own group after success or failure.

Guard checks need no database or provider:

```sh
node --test tests/e2e/fixtures/fred/guards.test.mjs
```
