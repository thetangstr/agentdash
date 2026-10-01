#!/usr/bin/env node
// Generate docs/api/openapi.yaml: the OpenAPI 3.1 contract for the public HTTP
// API (doc/plans/2026-10-01-public-docs-section.md, "Generated references and
// drift checks").
//
// Three inputs, none hand-copied:
//   - docs/api/contract.json — WHICH routes are in the contract, and the one
//     line of prose each carries. Hand-maintained; the only hand-written input.
//   - request bodies: the zod validators exported by @paperclipai/shared,
//     converted with @asteasolutions/zod-to-openapi;
//   - response bodies: the TypeScript types exported by @paperclipai/shared,
//     converted with ts-json-schema-generator.
// The auth schemes and error responses below are written from
// server/src/middleware/auth.ts, server/src/middleware/error-handler.ts and
// server/src/middleware/rate-limit.ts; each says where it comes from.
//
// A validator or type that cannot be converted does not fail the build: the
// operation gets a description saying the schema was not generated, and the
// generator reports it. Output is deterministic (no timestamps, sorted
// components), so scripts/ci/check-api-reference-drift.mjs can compare a fresh
// run with the committed file.
//
// The shared package is TypeScript source, so it is loaded through tsx's ESM
// loader. zod-to-openapi patches zod's prototypes, so it must patch the SAME
// zod module instance the shared validators were built with: that instance is
// resolved from packages/shared, not from here.
//
// Usage: node scripts/docs/generate-openapi.mjs [--check] [--out <dir>]

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OPENAPI_REL = "docs/api/openapi.yaml";
const CONTRACT_REL = "docs/api/contract.json";
const SHARED_DIR_REL = "packages/shared";

/**
 * Enum values kept off the public contract, with the reason the schema prints:
 * a client's product profile id (the plan's Decisions, item 3), and an issue
 * origin named after a specific engagement (PR 3b review). Removed from every
 * generated enum; the schema says how many were omitted and why, and that
 * other values may appear.
 */
export const REDACTED_ENUM_REASONS = {
  agentdash_mk: "private",
  execos_request: "engagement-specific",
};
export const REDACTED_ENUM_VALUES = Object.keys(REDACTED_ENUM_REASONS);

/** The description an enum gets for the values removed from it. */
export function omittedValuesNote(removed) {
  const reasons = [...new Set(removed.map((value) => REDACTED_ENUM_REASONS[value]))].sort().join(", ");
  return `${removed.length} value${removed.length === 1 ? "" : "s"} omitted: ${reasons}. Other values may appear.`;
}

const ERROR_SCHEMA = {
  type: "object",
  description: "Every error is JSON with a human-readable `error`. Some carry `details` (a validation error lists the failing fields) or a machine-readable `code`.",
  properties: {
    error: { type: "string" },
    details: {},
    code: { type: "string" },
  },
  required: ["error"],
};

const RATE_LIMIT_SCHEMA = {
  type: "object",
  properties: {
    error: { type: "string", const: "Rate limited" },
    retryAfter: { type: "integer", description: "Seconds until the window resets (900)." },
  },
  required: ["error", "retryAfter"],
};

const ERROR_RESPONSES = {
  BadRequest: {
    description:
      "The request is malformed. `Invalid identifier` when a path or query id is not a UUID (server/src/middleware/error-handler.ts); `Validation error` with `details` when the body fails its schema.",
  },
  Unauthorized: { description: "No credential, or the credential did not resolve to an actor." },
  Forbidden: {
    description:
      "The caller is authenticated but may not do this: a missing permission, a read-only principal, or a credential that cannot reach this route (an assistant grant without the required scope answers `insufficient_scope`).",
  },
  NotFound: {
    description:
      "No such resource, **or one the caller is not allowed to see**. Visibility answers 404, never 403: a 403 on a guessed id would confirm the thing exists (server/src/routes/visibility.ts).",
  },
  Conflict: { description: "The resource is not in a state that allows this (for example, an issue already checked out by another agent)." },
  Unprocessable: { description: "The body is well-formed but asks for something the server will not do." },
  RateLimited: {
    description:
      "Rate limited (server/src/middleware/rate-limit.ts). Under /api, state-changing requests are limited per actor (or per IP when unauthenticated): 200 per 15 minutes by default, lower on auth, billing, invite and trial routes. Authenticated reads are not counted. The response carries `Retry-After` and the draft-7 `RateLimit` headers. Instances may configure other limits.",
    headers: {
      "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait." },
    },
    schema: "RateLimitError",
  },
};

const SECURITY_SCHEMES = {
  bearerBoardKey: {
    type: "http",
    scheme: "bearer",
    description:
      "A board API key (`pcp_board_…`): acts as the person who approved it, with that person's company memberships and nothing narrower — board keys have no scopes. Expires 30 days after it is minted. Minted by the CLI sign-in flow; see the API keys page. (server/src/middleware/auth.ts, `board_key`.)",
  },
  bearerAgentKey: {
    type: "http",
    scheme: "bearer",
    description:
      "An agent API key (`pcp_…`): acts as one agent in one company. Also accepted as the `x-agent-key` header when no Authorization header is sent. A run-scoped agent JWT issued to a local adapter is accepted the same way. (server/src/middleware/auth.ts, `agent_key` and `agent_jwt`.)",
  },
  session: {
    type: "apiKey",
    in: "cookie",
    name: "paperclip-default.session_token",
    description:
      "The web app's signed-in session cookie. The name is per instance (`<prefix>.session_token`, `__Secure-` prefixed over https); browsers send it automatically. Meant for the web app, not for integrations — use a board key. (server/src/middleware/auth.ts, `session`.)",
  },
  assistantOAuth: {
    type: "oauth2",
    description:
      "OAuth 2.1 with PKCE, for an assistant acting for one person in one company (`pcpa_…` access tokens). Discovery: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`. A grant reaches only the assistant routes its scopes allow; anything else is 403. (server/src/middleware/auth.ts, `assistant_grant`.)",
    flows: {
      authorizationCode: {
        authorizationUrl: "/oauth/authorize",
        tokenUrl: "/oauth/token",
        refreshUrl: "/oauth/token",
        scopes: {
          "agentdash:read": "Read the company's work.",
          "agentdash:work": "Create and move work, wake agents.",
          "agentdash:decide": "Resolve approvals and hire. Opt-in at consent; never granted by default.",
        },
      },
    },
  },
  bearerBridgeEndpoint: {
    type: "http",
    scheme: "bearer",
    description:
      "An enrolled machine's endpoint token. Resolved only on the bridge's own routes; on any other path it is treated as no credential at all. (server/src/middleware/auth.ts, `bridge_endpoint`.)",
  },
};

/**
 * Who may call a route, by its contract `auth` value. Absent means `any`: a
 * person (board key or session) or an agent. Agent-key schemes are listed only
 * where an agent can actually get past the handler's guards — the drift check
 * reads each handler and fails if a route that refuses agents up front is
 * listed with one (scripts/docs/route-guards.mjs).
 */
export const AUTH_SECURITY = {
  any: [{ bearerBoardKey: [] }, { bearerAgentKey: [] }, { session: [] }],
  board: [{ bearerBoardKey: [] }, { session: [] }],
  // server/src/services/human-control.ts `capture()`: a verified, unexpired board key only.
  "board-key": [{ bearerBoardKey: [] }],
  agent: [{ bearerAgentKey: [] }],
  assistant: [{ assistantOAuth: ["agentdash:read"] }],
  "bridge-endpoint": [{ bearerBridgeEndpoint: [] }],
  public: [{}],
};
const DEFAULT_SECURITY = AUTH_SECURITY.any;

/** The OpenAPI security requirement for a contract route. */
export function securityFor(route) {
  const security = AUTH_SECURITY[route.auth ?? "any"];
  if (!security) throw new Error(`${route.operationId}: unknown auth ${route.auth}`);
  return security;
}

const PARAM_DESCRIPTIONS = {
  companyId: "Company id (UUID).",
  keyId: "Key id (UUID).",
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

let sharedModules = null;

/** @paperclipai/shared from source, plus the zod instance it was built with. */
async function loadShared(repoRoot) {
  if (sharedModules) return sharedModules;
  const { register } = await import("tsx/esm/api");
  register();
  const sharedDir = path.join(repoRoot, SHARED_DIR_REL);
  const shared = await import(pathToFileURL(path.join(sharedDir, "src", "index.ts")).href);
  const requireFromShared = createRequire(path.join(sharedDir, "package.json"));
  const zodDir = path.dirname(realpathSync(requireFromShared.resolve("zod/package.json")));
  const zodPackage = JSON.parse(readFileSync(path.join(zodDir, "package.json"), "utf8"));
  const zodEntry = zodPackage.exports?.["."]?.import ?? zodPackage.module ?? "index.js";
  const zod = await import(pathToFileURL(path.join(zodDir, zodEntry)).href);
  sharedModules = { shared, z: zod.z ?? zod.default ?? zod };
  return sharedModules;
}

function pascal(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** `createCompanySchema` → `CreateCompanyRequest`. */
export function requestComponentName(validatorName) {
  return `${pascal(validatorName.replace(/Schema$/, ""))}Request`;
}

/** A JSON-schema definition name as a valid OpenAPI component key. */
function componentKey(name) {
  return decodeURIComponent(name).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+$/g, "");
}

function rewriteRefs(node, from, to) {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, from, to));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith(from)) {
      out[key] = `${to}${componentKey(value.slice(from.length))}`;
    } else {
      out[key] = rewriteRefs(value, from, to);
    }
  }
  return out;
}

/** Remove redacted enum values everywhere; an enum left empty is dropped. */
export function redactEnums(node) {
  if (Array.isArray(node)) return node.map(redactEnums).filter((item) => item !== REDACTED);
  if (!node || typeof node !== "object") return node;
  if (typeof node.const === "string" && REDACTED_ENUM_VALUES.includes(node.const)) return REDACTED;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "enum" && Array.isArray(value)) {
      const kept = value.filter((item) => !REDACTED_ENUM_VALUES.includes(item));
      if (kept.length !== value.length) {
        out.enum = kept;
        const removed = value.filter((item) => REDACTED_ENUM_VALUES.includes(item));
        out.description = [node.description, omittedValuesNote(removed)].filter(Boolean).join(" ");
        continue;
      }
    }
    if (key === "description" && out.description) continue;
    const next = redactEnums(value);
    if (next !== REDACTED) out[key] = next;
  }
  return out;
}
const REDACTED = Symbol("redacted");

async function requestSchemas(repoRoot, names) {
  const { shared, z } = await loadShared(repoRoot);
  const { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } = await import("@asteasolutions/zod-to-openapi");
  extendZodWithOpenApi(z);
  const schemas = {};
  const failed = [];
  for (const name of names) {
    const schema = shared[name];
    if (!schema || typeof schema.safeParse !== "function") {
      failed.push({ kind: "request", name, reason: "not a zod schema exported by @paperclipai/shared" });
      continue;
    }
    try {
      // One registry per validator: a failure in one cannot take the others down.
      const registry = new OpenAPIRegistry();
      registry.register(requestComponentName(name), schema);
      const generated = new OpenApiGeneratorV31(registry.definitions).generateComponents();
      Object.assign(schemas, generated.components?.schemas ?? {});
    } catch (error) {
      failed.push({ kind: "request", name, reason: String(error?.message ?? error).split("\n")[0] });
    }
  }
  return { schemas, failed };
}

async function responseSchemas(repoRoot, names) {
  const { createGenerator } = await import("ts-json-schema-generator");
  const sharedDir = path.join(repoRoot, SHARED_DIR_REL);
  const schemas = {};
  const failed = [];
  if (names.length === 0) return { schemas, failed };
  let generator;
  try {
    generator = createGenerator({
      path: path.join(sharedDir, "src", "index.ts"),
      tsconfig: path.join(sharedDir, "tsconfig.json"),
      type: names[0],
      skipTypeCheck: true,
      expose: "export",
      topRef: true,
      // Type comments in this repo are engineering notes, not API prose.
      jsDoc: "none",
      additionalProperties: true,
    });
  } catch (error) {
    for (const name of names) failed.push({ kind: "response", name, reason: String(error?.message ?? error).split("\n")[0] });
    return { schemas, failed };
  }
  for (const name of names) {
    try {
      const generated = generator.createSchema(name);
      for (const [definition, schema] of Object.entries(generated.definitions ?? {})) {
        schemas[componentKey(definition)] = rewriteRefs(schema, "#/definitions/", "#/components/schemas/");
      }
      if (!schemas[name]) throw new Error(`no definition named ${name}`);
    } catch (error) {
      failed.push({ kind: "response", name, reason: String(error?.message ?? error).split("\n")[0] });
    }
  }
  return { schemas, failed };
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export function openApiPath(expressPath) {
  return expressPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function pathParameters(route) {
  return [...route.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(([, name]) => {
    let description = PARAM_DESCRIPTIONS[name] ?? `${pascal(route.tag).replace(/s$/, "").replace(/-./g, (m) => m[1].toUpperCase())} id (UUID).`;
    if (route.tag === "issues" && name === "id") description = "Issue id (UUID) or identifier, such as `ENG-12`.";
    return { name, in: "path", required: true, description, schema: { type: "string" } };
  });
}

function sortObject(object) {
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function buildOpenApiDocument(repoRoot) {
  const contract = JSON.parse(readFileSync(path.join(repoRoot, CONTRACT_REL), "utf8"));
  const routes = contract.routes ?? [];
  const validators = [...new Set(routes.map((route) => route.requestValidator).filter(Boolean))].sort();
  const types = [...new Set(routes.map((route) => route.responseType).filter(Boolean))].sort();

  const request = await requestSchemas(repoRoot, validators);
  const response = await responseSchemas(repoRoot, types);
  const failedRequest = new Set(request.failed.map((entry) => entry.name));
  const failedResponse = new Set(response.failed.map((entry) => entry.name));

  const paths = {};
  for (const route of routes) {
    const operation = {
      operationId: route.operationId,
      summary: route.summary,
      tags: [route.tag],
    };
    const notes = route.description ? [route.description] : [];
    const parameters = pathParameters(route);
    for (const query of route.query ?? []) {
      parameters.push({ name: query.name, in: "query", required: false, description: query.description, schema: query.schema ?? { type: "string" } });
    }
    for (const header of route.headers ?? []) {
      parameters.push({ name: header.name, in: "header", required: header.required === true, description: header.description, schema: header.schema ?? { type: "string" } });
    }
    if (parameters.length > 0) operation.parameters = parameters;

    if (route.requestValidator && !failedRequest.has(route.requestValidator)) {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${requestComponentName(route.requestValidator)}` } } },
      };
    } else if (route.requestValidator) {
      notes.push(`Request schema not generated: \`${route.requestValidator}\` could not be converted.`);
    } else if (MUTATING.has(route.method)) {
      notes.push("Request schema not generated: the route has no shared validator.");
    }

    const success = String(route.successStatus ?? 200);
    const responses = {};
    if (route.responseType && !failedResponse.has(route.responseType)) {
      const ref = { $ref: `#/components/schemas/${route.responseType}` };
      responses[success] = {
        description: "Success.",
        content: { "application/json": { schema: route.responseIsArray ? { type: "array", items: ref } : ref } },
      };
    } else {
      responses[success] = { description: "Success. Response schema not generated." };
      notes.push(
        route.responseType
          ? `Response schema not generated: \`${route.responseType}\` could not be converted.`
          : "Response schema not generated: the route returns no named shared type.",
      );
    }
    const hasParams = /:[A-Za-z_]/.test(route.path);
    const isPublic = route.auth === "public";
    if (hasParams || route.requestValidator) responses["400"] = { $ref: "#/components/responses/BadRequest" };
    if (!isPublic) {
      responses["401"] = { $ref: "#/components/responses/Unauthorized" };
      responses["403"] = { $ref: "#/components/responses/Forbidden" };
    }
    if (hasParams) responses["404"] = { $ref: "#/components/responses/NotFound" };
    if (MUTATING.has(route.method) && !isPublic) {
      responses["409"] = { $ref: "#/components/responses/Conflict" };
      responses["422"] = { $ref: "#/components/responses/Unprocessable" };
    }
    if (route.tag !== "health") responses["429"] = { $ref: "#/components/responses/RateLimited" };
    if (route.tag === "health") responses["503"] = { description: "The server is up but unhealthy (for example, the database is unreachable)." };
    operation.responses = sortObject(responses);
    if (notes.length > 0) operation.description = notes.join("\n\n");
    operation.security = securityFor(route);
    operation["x-stability"] = route.stability;

    const openPath = openApiPath(route.path);
    paths[openPath] ??= {};
    paths[openPath][route.method.toLowerCase()] = operation;
  }

  const responses = {};
  for (const [name, spec] of Object.entries(ERROR_RESPONSES)) {
    const schemaRef = { $ref: `#/components/schemas/${spec.schema ?? "Error"}` };
    responses[name] = {
      description: spec.description,
      ...(spec.headers ? { headers: spec.headers } : {}),
      content: { "application/json": { schema: schemaRef } },
    };
  }

  const document = {
    openapi: "3.1.0",
    info: {
      title: "AgentDash API",
      version: contract.version ?? "v1",
      description: [
        "The public HTTP API contract. Every operation here is a promise: it is not removed or renamed without a deprecation cycle.",
        "Routes not in this document are internal and may change without notice; the route index lists them.",
        "Generated by scripts/docs/generate-openapi.mjs from docs/api/contract.json, the zod validators and the TypeScript types in @paperclipai/shared. Do not edit by hand.",
      ].join("\n\n"),
    },
    // One contract, many instances: the reference page prefills this variable
    // on an instance and asks for it on the public site
    // (ui/src/lib/api-reference-server.ts, which holds the same placeholder).
    servers: [
      {
        url: "{instanceUrl}",
        description: "Your AgentDash instance.",
        variables: {
          instanceUrl: { default: "https://your-instance.example", description: "Your AgentDash instance's address" },
        },
      },
    ],
    security: DEFAULT_SECURITY,
    tags: (contract.tags ?? []).map((tag) => ({ name: tag.name, "x-displayName": tag.title, description: tag.description })),
    paths,
    components: {
      securitySchemes: SECURITY_SCHEMES,
      responses,
      schemas: sortObject({
        ...request.schemas,
        ...response.schemas,
        Error: ERROR_SCHEMA,
        RateLimitError: RATE_LIMIT_SCHEMA,
      }),
    },
  };
  return {
    document: redactEnums(document),
    unconverted: [...request.failed, ...response.failed],
    routes: routes.length,
  };
}

export async function buildOpenApiYaml(repoRoot) {
  const { stringify } = await import("yaml");
  const built = await buildOpenApiDocument(repoRoot);
  const header = "# Generated by scripts/docs/generate-openapi.mjs from docs/api/contract.json. Do not edit by hand.\n";
  return { ...built, yaml: header + stringify(built.document, { lineWidth: 0, aliasDuplicateObjects: false }) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const args = process.argv.slice(2);
  const { yaml, unconverted, routes } = await buildOpenApiYaml(repoRoot);
  for (const entry of unconverted) console.warn(`schema not generated: ${entry.kind} ${entry.name} — ${entry.reason}`);
  if (args.includes("--check")) {
    const target = path.join(repoRoot, OPENAPI_REL);
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current !== yaml) {
      console.error(`${OPENAPI_REL} is stale. Run: node scripts/docs/generate-openapi.mjs`);
      process.exit(1);
    }
    console.log(`${OPENAPI_REL} is current.`);
    return;
  }
  const outIndex = args.indexOf("--out");
  const outDir = outIndex !== -1 ? path.resolve(args[outIndex + 1]) : repoRoot;
  const target = path.join(outDir, OPENAPI_REL);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, yaml);
  console.log(`Wrote ${path.relative(process.cwd(), target) || target} (${routes} operations, ${unconverted.length} schemas not generated).`);
}

// Entry guard: resolve symlinks on both sides, or a symlinked invocation
// silently skips main() (scripts/entry-guard.test.mjs; cf. #666).
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
if (process.argv[1] && realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))) {
  await main();
}
