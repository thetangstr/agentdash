# AgentDash local preservation — 2026-10-10

This archive preserves local source work before retirement of the development SSD. It is separate from the application main branch. Unfinished snapshots have not been integrated or validated as a working product.

## Preserved

- A binary incremental Git bundle retaining local branch/tag/backup/review history beyond the live GitHub baseline: 2,431 commits and 1,428 bundle refs.
- A manifest of all 3,829 recorded Git refs, including 2,275 nonremote refs and 413 local branches. The remaining nonremote refs resolve through the baseline history retained by this archive commit's parents.
- 100 unfinished source/doc files, metadata and separate staged/unstaged binary patches from the dirty working trees. Files retain their recorded HEAD provenance.

Credential review: 90 history and 39 unfinished-source scanner findings were independently reviewed as synthetic fixtures or code patterns. Twenty private working-tree items (credential, runtime logs and unreviewed screenshots) were excluded. Ignored runtime state, database dumps, private company evidence and credentials require a separate protected backup and are not part of this public archive.

## Restore source history

Clone this repository normally, with this archive branch available. Its parent commits retain the baseline history required by the incremental bundle. In a separate clone:

```sh
git switch archive/local-preservation-20261010
cat history/history.bundle.part-* > /tmp/agentdash-local-history.bundle
git bundle verify /tmp/agentdash-local-history.bundle
git fetch /tmp/agentdash-local-history.bundle '+refs/*:refs/restored-local/*'
```

Check the combined file against the SHA-256 in history-manifest.json before importing. The imported refs are under refs/restored-local to avoid overwriting the clone's current branches or tags. local-refs.tsv records the original names and exact object IDs. To recreate the original nonremote refs, do it in a separate dedicated restoration repository, using that manifest after confirming the target objects exist. The original checkout had shallow history; a normal GitHub clone supplies complete public baseline ancestry, while the independent offline restore simulation retained the original shallow marker.

## Restore unfinished work

For each unfinished-work snapshot, start from the HEAD recorded in snapshot.json. Apply staged.patch to the index, then unstaged.patch to working files, and restore the saved untracked files from files/. These snapshots preserve work in progress and staged/unstaged distinctions; run the relevant application checks before integration.

## Drive removal boundary

This archive preserves source work. Four internal-disk linked worktrees still depend on the original SSD Git directory, and 42 private runtime skill-cache symlinks target the SSD. Repair those pointers and move the private artifact archive to durable protected storage before formatting. The emergency local archive under /private/tmp is temporary.
