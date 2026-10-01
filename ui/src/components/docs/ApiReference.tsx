// AgentDash — the rendered API reference at /docs/api/reference
// (doc/plans/2026-10-01-public-docs-section.md, PR 3a).
//
// Scalar renders docs/api/openapi.yaml. This module is the only one that
// imports Scalar, and Docs.tsx loads it with React.lazy only for a page whose
// front matter says `kind: openapi`, so Scalar and its stylesheet are one chunk
// that no other page — and nothing in the initial bundle — downloads.
//
// One source: the YAML is imported with `?url`, so Vite emits the committed
// docs/api/openapi.yaml as a static asset and hands this module its URL; the
// page fetches it at runtime and the download link points at the same file.
// No copy of the spec lives under ui/.
//
// No vendor services: telemetry off, Scalar's default web fonts off (they load
// from Scalar's CDN), its AI agent and MCP panels off, and no request proxy —
// "try it" requests go straight from the browser to the instance.

import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import specUrl from "../../../../docs/api/openapi.yaml?url";

export const OPENAPI_SPEC_URL: string = specUrl;

export function ApiReference({ dark }: { dark: boolean }) {
  return (
    <div className="flex flex-col gap-3" data-testid="api-reference">
      <p className="text-sm">
        <a href={specUrl} download="openapi.yaml" className="underline">
          Download openapi.yaml
        </a>{" "}
        <span className="text-muted-foreground">— OpenAPI 3.1</span>
      </p>
      <div className="overflow-hidden rounded-md border border-border">
        <ApiReferenceReact
          configuration={{
            url: specUrl,
            layout: "classic",
            hideDarkModeToggle: true,
            forceDarkModeState: dark ? "dark" : "light",
            withDefaultFonts: false,
            telemetry: false,
            agent: { disabled: true },
            mcp: { disabled: true },
            showDeveloperTools: "never",
            documentDownloadType: "none",
          }}
        />
      </div>
    </div>
  );
}

export default ApiReference;
