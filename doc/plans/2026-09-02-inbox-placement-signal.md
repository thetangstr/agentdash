# "Placed in your inbox" needs its own signal

Status: **problem statement and options. Not implemented. This branch fails CI
on purpose.**

## The bug this branch tries to fix

`touchedByUserCondition` counts a read-state row as participation. So opening an
issue once enrols you in it permanently. It falls hardest on whoever reads the
most: an administrator browsing the board acquires an inbox of other people's
agents' work, none of it waiting on them, with no way to reach zero except
archiving each item by hand. Measured on one instance: 3 issues created, 0
assigned, 0 commented — and 9 present purely because they had been clicked.

An inbox that cannot be emptied stops being read, and then the one approval that
did need a human is missed along with the rest.

## Why removing the clause is not enough

`issue_read_states` is doing two jobs.

1. "I looked at this." Browsing. Not participation.
2. "This was deliberately put in front of you." The routines service places a
   coalesced routine run into the **manual runner's** inbox by writing a
   read-state row for them. That person asked for the run — it is genuine
   participation.

Dropping the clause takes job 2 out along with job 1. Two tests in
`routines-service.test.ts` catch it:

- `touches a coalesced routine issue for the manual runner's inbox`
- `touches a skipped active routine issue for the manual runner's inbox`

**Those tests are the specification, not an obstacle.** They should not be
weakened, skipped, or rewritten to accommodate this branch. They describe a
feature that works today.

## Why there is no cheap fix

The obvious escape would be to derive "this user triggered this routine run"
from existing data. It cannot be done: `routine_runs` has `source` (`"manual"`)
but **no triggering-user column**. The `userId` is passed transiently into
`runRoutine(...)` and the read-state row it writes is the only persisted record
that this person asked for the run.

So the signal has to be created. Every option below is a migration.

## Options

**A. Add `triggered_by_user_id` to `routine_runs`.** Smallest change, and it
records something the system should arguably have been recording anyway — who
asked for a manual run. The inbox condition then admits routine-origin issues
whose run was manually triggered by this user, and read-state goes back to
meaning only "I looked at this".
*Cost:* one nullable column; existing rows stay null, so historical manual runs
lose their inbox placement. Acceptable — they are already read.

**B. Add a kind/flag to `issue_read_states`** distinguishing a deliberate
placement from a passive read.
*Cost:* keeps the overloading, just makes it explicit. The table would still
mean two things, which is how this bug happened.

**C. New `issue_inbox_placements` table.** Cleanest model — placement becomes a
first-class relationship rather than a side effect.
*Cost:* a new table and a new write path for every future "put this in front of
someone" feature. Probably right eventually; heavier than this fix needs.

**Recommendation: A.** It is the smallest migration, it fixes the actual gap
(nobody records who triggered a manual run), and it lets read-state go back to
meaning one thing.

## One thing to weigh before shipping any of them

All three are forward-only migrations — this project has no down-migrations. The
OTA apply path therefore classifies any release carrying one as `forward_only`:
applying is fine, but rolling back requires restoring the pre-update backup and
losing whatever was written since.

That is worth knowing because the first instance due to move onto the release
layout has not yet performed a single controlled update. Landing this in the
same release as that instance's first OTA cutover would mean its first update is
also its least reversible one. Sequence them apart.

## What is on this branch

- The narrowing itself, restored in `touchedByUserCondition`.
- Its regression test, `does not put an issue in your inbox just because you
  opened it`.
- This note.

Nothing else. The two routines tests fail, and that failure is the remaining
work.
