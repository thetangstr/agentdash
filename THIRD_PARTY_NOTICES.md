# Third-Party Notices

This repository includes third-party software under a mix of permissive and weak-copyleft licenses.

The current inventory can be regenerated with:

```sh
pnpm licenses list --json
```

## Project License

AgentDash is distributed under the MIT license. See [LICENSE](./LICENSE).

## Commercial Packaging Summary

As of 2026-03-31, the previously identified commercial redistribution blocker from the CodeSandbox Sandpack dependency chain has been removed from the resolved dependency graph.

Notable remaining third-party licenses in the installed dependency tree:

- `dompurify@3.3.2` — `(MPL-2.0 OR Apache-2.0)`
- `lightningcss@1.30.2` — `MPL-2.0`
- `lightningcss-darwin-arm64@1.30.2` — `MPL-2.0`
- `@img/sharp-libvips-darwin-arm64@1.2.4` — `LGPL-3.0-or-later`
- `khroma@2.1.0` — reported as `Unknown` by package metadata, but the installed package includes an MIT license file

## Packaging Notes

- MIT / BSD / Apache / ISC / Unlicense / CC0 dependencies are generally compatible with commercial redistribution when their notices are preserved where required.
- `dompurify` offers an Apache-2.0 option. If you redistribute it, preserve the upstream license text and notices.
- `lightningcss` is MPL-2.0. If you modify MPL-covered files, keep those modified files available under MPL-2.0 and preserve notices.
- `sharp-libvips` is an LGPL-licensed native dependency. If you redistribute binaries that bundle it, preserve the LGPL license text and satisfy applicable relinking / replacement rights.
- `khroma` should be treated as MIT despite the package metadata false positive; verify on version bumps because the automated inventory reports it as `Unknown`.

## Recommended Distribution Bundle Contents

For commercial releases, include:

- the repo `LICENSE`
- a copy of this `THIRD_PARTY_NOTICES.md`
- any upstream license texts required by bundled binary distributions

## Regeneration Date

- Last reviewed: 2026-03-31
