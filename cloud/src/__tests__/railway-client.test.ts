// GH #763 precondition 3: the Railway GraphQL client never logs request
// variables, and never lets one reach an error, even when Railway echoes it.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";
import { parseRetryAfter, RailwayApiError, RailwayClient, scrubMessage } from "../railway/client.js";
import { Secret } from "../secret.js";

// Synthetic values. A bare UUID under variables.value is the case the #779
// review found the logger could not recognise on its own.
const TOKEN = "0d9a3b52-6c1e-4f7a-8b2d-9e0f1a2b3c4d";
const BARE_UUID = "5b1f6e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const SECRETS = {
  BETTER_AUTH_SECRET: "f".repeat(8) + "0123456789abcdef0123456789abcdef",
  PAPERCLIP_SECRETS_MASTER_KEY: "c2VjcmV0LW1hc3Rlci1rZXktdmFsdWUtZmFrZQ==",
  AGENTDASH_INVITE_CODES: "AGD-0A1B2C3D4E5F60718293A4B5C6",
  POSTGRES_PASSWORD: "Zq9vX2mN7bL4kJ8hG1fD3sA6pO0iU5yT",
};

function capture() {
  const lines: string[] = [];
  return { log: createLogger({ write: (l) => lines.push(l), level: "debug" }), text: () => lines.join("\n") };
}

type Handler = (body: { query: string; variables: Record<string, unknown> }, headers: Headers) => Response | Promise<Response>;

function fakeFetch(handler: Handler): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    return handler(body, new Headers(init?.headers));
  }) as typeof fetch;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const VARS = {
  i: { projectId: "p1", environmentId: "e1", serviceId: "s1", variables: { ...SECRETS }, skipDeploys: true },
  value: BARE_UUID,
};
const ALL = [TOKEN, BARE_UUID, ...Object.values(SECRETS)];

describe("RailwayClient", () => {
  it("sends the token only in the Authorization header and returns data", async () => {
    let seen: Headers | null = null;
    const client = new RailwayClient({
      token: new Secret(TOKEN),
      fetch: fakeFetch((b, h) => {
        seen = h;
        expect(b.variables).toEqual(VARS);
        return json(200, { data: { variableCollectionUpsert: true } });
      }),
    });
    await expect(client.request("variableCollectionUpsert", "mutation{x}", VARS)).resolves.toEqual({ variableCollectionUpsert: true });
    expect(seen!.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("logs no variable, not even a bare UUID under variables.value, on success or failure", async () => {
    const { log, text } = capture();
    const ok = new RailwayClient({ token: new Secret(TOKEN), log, fetch: fakeFetch(() => json(200, { data: { ok: true } })) });
    await ok.request("variableCollectionUpsert", "mutation{x}", VARS);
    const bad = new RailwayClient({
      token: new Secret(TOKEN),
      log,
      fetch: fakeFetch((b) => json(400, { errors: [{ message: `Variable "$i" got invalid value ${JSON.stringify(b.variables.i)}` }, { message: `no service ${BARE_UUID}` }] })),
    });
    const err = await bad.request("variableCollectionUpsert", "mutation{x}", VARS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RailwayApiError);
    log.error("step failed", { err });
    const out = text();
    for (const v of ALL) expect(out).not.toContain(v);
    expect(out).toContain("variableCollectionUpsert");
  });

  it("keeps echoed variables out of the error message, stack, JSON and inspect output", async () => {
    const client = new RailwayClient({
      token: new Secret(TOKEN),
      fetch: fakeFetch(() =>
        json(200, {
          errors: [
            { message: `Variable "$i" got invalid value { "variables": { "POSTGRES_PASSWORD": "${SECRETS.POSTGRES_PASSWORD}" } }` },
            { message: `Service ${BARE_UUID} not found; code ${SECRETS.AGENTDASH_INVITE_CODES}` },
          ],
          data: null,
        }),
      ),
    });
    const err = (await client.request("serviceInstanceUpdate", "mutation{x}", VARS).catch((e: unknown) => e)) as RailwayApiError;
    const surfaces = [err.message, err.stack ?? "", JSON.stringify(err), inspect(err), err.messages.join("\n")].join("\n");
    for (const v of ALL) expect(surfaces).not.toContain(v);
    expect(err.messages[0]).toBe("invalid value for variable $i (value withheld)");
    expect(err.messages[1]).toContain("not found");
  });

  it("wraps transport failures without the underlying error (which may carry the request)", async () => {
    const { log, text } = capture();
    const client = new RailwayClient({
      token: new Secret(TOKEN),
      log,
      fetch: (async () => {
        const e = new TypeError(`fetch failed for body ${JSON.stringify(VARS)}`) as TypeError & { code?: string };
        e.code = "ECONNRESET";
        throw e;
      }) as typeof fetch,
    });
    const err = (await client.request("projectCreate", "mutation{x}", VARS).catch((e: unknown) => e)) as RailwayApiError;
    expect(err.status).toBe(0);
    expect(err.message).toContain("ECONNRESET");
    const surfaces = [err.message, err.stack ?? "", inspect(err), text()].join("\n");
    for (const v of ALL) expect(surfaces).not.toContain(v);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it("reports 429 with the Retry-After delay, and rate-limit errors in a 200", async () => {
    const limited = new RailwayClient({ token: new Secret(TOKEN), fetch: fakeFetch(() => json(429, { errors: [{ message: "Too many requests" }] }, { "retry-after": "42" })) });
    const e1 = (await limited.request("deployments", "query{x}").catch((e: unknown) => e)) as RailwayApiError;
    expect(e1.status).toBe(429);
    expect(e1.rateLimited).toBe(true);
    expect(e1.retryAfterMs).toBe(42_000);
    const soft = new RailwayClient({ token: new Secret(TOKEN), fetch: fakeFetch(() => json(200, { errors: [{ message: "Rate limit exceeded" }], data: null })) });
    const e2 = (await soft.request("deployments", "query{x}").catch((e: unknown) => e)) as RailwayApiError;
    expect(e2.rateLimited).toBe(true);
    expect(e2.retryAfterMs).toBeNull();
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("15")).toBe(15_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const now = Date.parse("2026-09-26T00:00:00Z");
    expect(parseRetryAfter("Sat, 26 Sep 2026 00:01:00 GMT", now)).toBe(60_000);
  });

  it("scrubs every variable value, longest first", () => {
    expect(scrubMessage("value abcdef and abc", ["abcdef", "abc"])).toBe("value [REDACTED] and [REDACTED]");
  });
});
