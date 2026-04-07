# Commercial Packaging Blockers

Date: 2026-03-31
Status: completed

## Goal

Remove the licensing and packaging blockers that would make an AgentDash commercial distribution risky or misleading.

## Issues

### 1. Replace the editor dependency chain with a permissive local implementation

Problem:
- `@mdxeditor/editor` pulled in `@codesandbox/sandpack-react`, which pulled in `@codesandbox/nodebox`
- `@codesandbox/nodebox` ships under the Sustainable Use License, which is not acceptable for commercial redistribution

Resolution:
- replaced the shared markdown editor with a local textarea-based markdown editor
- removed the `@mdxeditor/editor` dependency from the UI package
- removed the now-unused mention-editor support files tied to the old editor stack

### 2. Remove customer-facing upstream Paperclip branding from shipped surfaces

Problem:
- the shipped app still exposed `Paperclip` in the manifest, auth UI, exported docs, and skill-management labels

Resolution:
- updated the PWA manifest to `AgentDash`
- updated visible app labels to `AgentDash`
- updated company export copy to point to the AgentDash repo and command alias

### 3. Align distributable package metadata with AgentDash

Problem:
- package metadata still pointed published artifacts at `paperclipai/paperclip`
- root package metadata was incomplete for license/repository fields

Resolution:
- updated CLI package name to `agentdash`
- added the `agentdash` CLI bin while keeping `agentdash` as a compatibility alias
- updated package homepage / repository / bugs metadata to the AgentDash repo
- added missing `license` metadata at the root and website package

### 4. Add explicit third-party license guidance for commercial distribution

Problem:
- packaging work had no in-repo notices artifact explaining the remaining third-party obligations

Resolution:
- added `THIRD_PARTY_NOTICES.md`
- documented the remaining notable licenses after the editor replacement and install refresh

## Verification

Planned verification after implementation:
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- `pnpm licenses list --json`
