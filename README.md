# AgentDash local preservation — 2026-10-10

This archive preserves recorded local source work before retirement of the development SSD. It is separate from the application main branch. Unfinished work has not been integrated or validated as a working product.

## Preserved

- Original named-ref history beyond the live GitHub baseline: 2,431 incremental commits and 1,428 bundle refs. The baseline history is retained by the initial archive commit's 245 parents.
- A supplemental bundle with 252 exact recovery anchors, including detached review checkouts and reflog-only work (251 additional commits).
- Cached upstream history: 7,283 additional commits and 776 exact recovery anchors.
- All 3,829 recorded ref names/object IDs, including 413 local branches; all 210 recorded worktree HEADs; and all 15,035 commits originally reachable through refs/reflogs. These were checked in an independent offline restoration repository without object alternates.
- 100 unfinished source/doc files, snapshot metadata and separate staged/unstaged binary patches. All 120 original changed/untracked files were preserved privately; 20 private files are excluded here.

Ignored artifacts require a separate protected backup. Credentials, database dumps, private company evidence, runtime logs and unreviewed screenshots are excluded from this public archive. Ignored recovery archives and patches are preserved privately and are not all classified for public upload. This source archive does not replace that private backup.

## Restore source history

Use a separate normal clone with this archive branch available. Restore the three bundles in this order; verify each SHA-256 against its manifest before importing:

```sh
git switch archive/local-preservation-20261010
cat history/history.bundle.part-* > /tmp/agentdash-local-history.bundle
git bundle verify /tmp/agentdash-local-history.bundle
git fetch /tmp/agentdash-local-history.bundle '+refs/*:refs/restored-local/*'

git bundle verify history/recovered-local-history.bundle
git fetch history/recovered-local-history.bundle '+refs/*:refs/restored-reflog/*'

cat history/cached-upstream.bundle.part-* > /tmp/agentdash-cached-upstream.bundle
git bundle verify /tmp/agentdash-cached-upstream.bundle
git fetch /tmp/agentdash-cached-upstream.bundle '+refs/*:refs/restored-upstream/*'
```

The imported refs use separate namespaces to avoid overwriting existing branches or tags. local-refs.tsv records the original ref names and exact IDs. Recreate those names only in a dedicated restoration repository after confirming their objects exist. recovered-local-anchors.json, cached-upstream-anchors.json and worktree-heads.json record supplemental provenance.

The original checkout was shallow. A normal GitHub clone supplies public baseline ancestry. The independent offline restoration retained the original shallow boundary, recorded in original-shallow.txt; it proves preservation of locally available history, not retrieval of previously absent pre-boundary history.

## Restore unfinished work

For each snapshot, start from the HEAD recorded in snapshot.json. Apply staged.patch to the index, then unstaged.patch to working files, and restore saved untracked files from files/. Snapshots preserve staged/unstaged distinctions. Run relevant application checks before integration.

## Drive removal boundary

Four internal-disk linked worktrees still depend on the original SSD Git directory. Forty-two private runtime skill-cache links target the SSD (14 were already dangling). Repair those pointers and verify a durable protected private backup before formatting. The emergency archive under /private/tmp is temporary. This branch does not assert the drive is safe to format.
