---
title: Versioning and deprecation
summary: What may change in the API contract and when, how a breaking change is announced, and what internal routes promise.
---

The API contract is version **`v1`**. Under the policy proposed here, additive changes may ship in any release, and a breaking change to a contract operation will be announced in the release notes at least one stable release before it lands, with the old shape kept working for 60 days after the announcement.

> **Status:** proposed 2026-10-01, in force from the first stable release that ships this page. Releases before that made no such promise, and some changed contract routes without notice. The [API changelog](/api/changelog) collects the API-affecting lines of their notes.

## What the contract is

The contract is the operations listed in `docs/api/contract.json` and rendered in [the API reference](/api/reference). Paths carry no version. `docs/api/openapi.yaml` states the version as `info.version: v1`. Everything on this page applies to contract operations only.

## Changes that ship in any release

These are **additive**. They need no notice. Build your client so they do not break it:

- **New fields** in a response. Ignore fields you do not know.
- **New optional fields** in a request body.
- **New routes**, and new operations added to the contract.
- **New enum values** in a response field. Treat an unknown value as "something else", not as an error. The reference already says "Other values may appear" where the document leaves a value out.
- **Wider accepted input**: a required field becoming optional, a limit raised, a new accepted format.

## Changes that need a deprecation cycle

These are **breaking**:

- **Removing** an operation, a path, a request field or a response field.
- **Renaming** any of them, including a path parameter or a query parameter.
- **Narrowing accepted input**: an optional field becoming required, a limit lowered, a value or format that used to be accepted now refused.
- **Adding a required field or header** to a request.
- **Narrowing who may call an operation**: a credential, role or permission that was accepted no longer is.
- **Changing a field's type or nullability**, in a request or a response — including a field that was never null becoming nullable.
- **Changing a success status code**, such as 200 becoming 201 or 202.

A breaking change follows this sequence:

1. **Announce it.** The release notes of a stable release say what will change, what to use instead, and the earliest date it can land. The announcement goes under a heading named **Deprecated** or **Breaking**. This is a rule for whoever writes the notes; CI does not check the headings or the 60 days.
2. **Keep the old shape working** for at least 60 days after that release, and at least until the next stable release. The later of the two dates is the earliest the change can land.
3. **Land it.** The release that makes the change says so in its notes, under **Removed** or **Breaking**.

During the 60 days the operation stays in the contract and keeps working. Its `stability` stays `stable` (see below). The deprecation is visible in the release notes and the API changelog.

## Not covered by the policy

- **Error text.** The `error` string is for people and may change in any release. Match on the status code, then on `code` where one is documented ([Conventions](/api/conventions)).
- **Rate limits and defaults** described on [Conventions](/api/conventions). They are measured from the code, not promised.
- **Status codes for error cases.** This page does not yet decide whether changing one counts as breaking (a changed *success* code does, above). Until it does, such a change is listed in the release notes under **Upgrade notes**, as v2026.930.1 did when an unknown blocker id moved from 422 to 404.
- **Internal routes.** See the next section.

## Internal routes promise nothing

The server registers far more routes than the contract lists. [The route index](/api/route-index) lists all of them and labels everything outside the contract **internal**. An internal route can change shape, change status codes, or disappear in any release, without notice and without appearing in the release notes. The web app, the CLI and `agentdash-connect` use internal routes; that does not make them part of the contract.

If you need an internal route, ask for it to be added to the contract. Adding it is an additive change.

## Reading `stability`

Every contract operation carries a `stability` field in `docs/api/contract.json`, emitted as `x-stability` on the operation in `docs/api/openapi.yaml`.

- In `v1` every operation is **`stable`**: it is covered by this policy. The drift check (`scripts/ci/check-api-reference-drift.mjs`) accepts no other value.
- An operation that is not in the contract has no `stability`. It is internal.
- An operation keeps `stable` while it is deprecated. A deprecation is a dated announcement, not a change of label.

## Where breaking changes are listed

- **The release notes** — `releases/<version>.md`, the GitHub Release for each version, and the in-app changelog — under **Deprecated**, **Breaking** or **Removed**.
- **[The API changelog](/api/changelog)**, generated from the release notes. It keeps every line under those headings (and under the **Behaviour Change** headings earlier notes used), plus every line that names a route, a status code, a header or the API — except lines withheld as not public, which its header counts.

## How the contract is kept

- A contract route that the server stops registering fails CI (`scripts/ci/check-api-reference-drift.mjs`): it cannot be removed or renamed by accident, only on purpose, with this cycle.
- A changed request validator or response type fails CI until `docs/api/openapi.yaml` is regenerated. Whether that change is additive or breaking is a reviewer's call on the diff; no check makes it.
- What CI does not see: body checks a handler makes without a shared schema (the bridge routes, for example), and the status codes a handler answers. Those rely on review and on the resource pages.
- The contract started small and widens when someone asks for a route. See [the overview](/api/index).
