# Work log

Append-only journal of finished work bulks, so anyone (human or agent) can catch up fast.
Newest at the BOTTOM. Append an entry whenever a bulk of work wraps (ideally right before the
commit/PR that ships it). Keep entries SHORT: header line + What + Refs, nothing else.

Every MAW agent (`/builder`, `/tester`, `/workon`) should **read the last ~5–10 entries before
starting** (`tail` recipe below) and **append one when it finishes**. Rich per-item detail lives
in the artifact's own `## Timeline`, not here.

**Entry grammar** (strict, one header line per entry):
```
## YYYY-MM-DD · Short title · #tag1 #tag2
What: 1-2 lines, outcome first.
Refs: AGE-123, PR #456, [doc](docs/slug.md) (new|updated).
```

**Tags** (reuse before inventing): `#maw` `#feature` `#fix` `#infra` `#docs` `#skill`
`#product` `#ops` `#research` `#billing` `#onboarding` `#agents`.

**Retrieval recipes** (macOS; entry headers always start `## 20`):
```bash
# index of all entries (one line each)
grep '^## 20' loops/LOG.md
# last 5 entries, full
tail -r loops/LOG.md | awk '{print} /^## 20/{c++; if(c==5) exit}' | tail -r
# all entries about a topic
awk '/^## 20/{p=/#billing/} p' loops/LOG.md
# entries from a month
awk '/^## 20/{p=/^## 2026-06/} p' loops/LOG.md
```

---

## 2026-06-21 · Loop-engineering substrate + harness adopted · #maw #skill #infra
What: Added the `loops/` knowledge substrate (signals/docs/domains + this LOG), an architectural
lint (`pnpm check:architecture`), the `new-loop` + `setup-codebase-harness` skills, and wired the
MAW agents to read/append this LOG and file signals. Loop runs now compound instead of resetting.
Refs: loops/ARCHITECTURE.md (new), scripts/check-architecture.mjs (new),
.claude/skills/{new-loop,setup-codebase-harness} (new), .claude/commands/{builder,tester,workon}.md (updated).
