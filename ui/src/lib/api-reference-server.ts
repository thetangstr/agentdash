/**
 * Which server the API reference's "try it" panel points at.
 *
 * docs/api/openapi.yaml declares one server, `{instanceUrl}`, with a placeholder
 * default: the contract is the same on every instance, so the document cannot
 * name one. The page fills the variable in when it knows the answer:
 *
 * - On an instance (any host but the public site), the instance's own address,
 *   by the same rule the docs use for `{{instanceUrl}}`: the `publicBaseUrl`
 *   from `/api/health`, else the page's origin. A reader on their own instance
 *   gets a working "try it".
 * - On the public site there is no instance to point at — its `/api` is not
 *   the reader's — so the variable keeps the placeholder and the reader is
 *   asked for their instance's address.
 */

/** The public marketing site, which serves the docs but is nobody's instance. */
export const PUBLIC_SITE_HOSTS: readonly string[] = ["www.agentdash.cloud", "agentdash.cloud"];

/** The `{instanceUrl}` default in docs/api/openapi.yaml. */
export const INSTANCE_URL_PLACEHOLDER = "https://your-instance.example";

/** The instance address to prefill, or null when the page is on the public site. */
export function referenceInstanceUrl(pageHostname: string, instanceUrl: string): string | null {
  if (PUBLIC_SITE_HOSTS.includes(pageHostname.toLowerCase())) return null;
  const trimmed = instanceUrl.trim().replace(/\/+$/, "");
  return trimmed || null;
}

/** Scalar's `servers` override: the document's one server, with its variable prefilled when known. */
export function referenceServers(instanceUrl: string | null) {
  return [
    {
      url: "{instanceUrl}",
      description: instanceUrl ? "This instance." : "Your AgentDash instance. Enter its address to try a request.",
      variables: {
        instanceUrl: {
          default: instanceUrl ?? INSTANCE_URL_PLACEHOLDER,
          description: "Your AgentDash instance's address",
        },
      },
    },
  ];
}

/**
 * The operation part of a reference anchor: the contract's `operationId`.
 *
 * Scalar's default anchor is `#tag/<tag>/<METHOD><path>`, which changes when a
 * path parameter is renamed and is awkward to link to. With this, an operation
 * lives at `/docs/api/reference#tag/<tag>/<operationId>` — the form the
 * resource pages link to, and the one scripts/ci/check-api-reference-drift.mjs
 * holds them to. Every contract route has an operationId; the fallback is
 * Scalar's own form, for safety only.
 */
export function referenceOperationSlug(input: { operationId?: string; method: string; path: string }): string {
  return input.operationId || `${input.method.toUpperCase()}${input.path}`;
}
