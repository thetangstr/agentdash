---
title: API reference
summary: Every operation in the public API contract, rendered from the OpenAPI 3.1 document.
kind: openapi
---

Every operation in the contract, with its parameters, request body, responses and the credentials it accepts. It is rendered from `docs/api/openapi.yaml`, which is generated from the contract manifest and the server's own validators and types — see [the overview](/api/index) for how it is kept current, and [the route index](/api/route-index) for the routes outside the contract.

Where an operation says "schema not generated", the route has no shared validator or response type yet; the operation is still in the contract.
