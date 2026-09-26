// AgentDash: an in-memory fake of the parts of Railway's GraphQL API the
// control plane uses, for tests (GH #763, #764). It dispatches on the
// operation in the query text, records every call, and can be told to fail a
// matching call (e.g. a 429 with Retry-After) a number of times.
import { RailwayClient } from "../railway/client.js";
import { Secret } from "../secret.js";

export const FAKE_TOKEN = "fake-railway-token-DO-NOT-LEAK-7f3a9c";
export const FAKE_WORKSPACE = "ws-boxes";

export interface FakeProject {
  id: string;
  name: string;
  description: string | null;
  workspaceId: string;
}

export interface FakeCall {
  op: string;
  variables: Record<string, unknown>;
}

interface Failure {
  match: RegExp;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  times: number;
}

export type Resolver = (variables: Record<string, unknown>, fake: FakeRailway) => unknown;

export class FakeRailway {
  readonly projects = new Map<string, FakeProject>();
  readonly calls: FakeCall[] = [];
  readonly failures: Failure[] = [];
  /** Extra operations (SC-2 adds services, volumes, variables, deployments…). */
  readonly resolvers: Array<{ match: RegExp; op: string; resolve: Resolver }> = [];
  #seq = 0;

  nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}-${this.#seq}`;
  }

  addProject(p: Partial<FakeProject> & { name: string }): FakeProject {
    const project = { id: p.id ?? this.nextId("proj"), description: p.description ?? null, workspaceId: p.workspaceId ?? FAKE_WORKSPACE, name: p.name };
    this.projects.set(project.id, project);
    return project;
  }

  failNext(match: RegExp, opts: { status: number; body?: unknown; headers?: Record<string, string>; times?: number }): void {
    this.failures.push({ match, status: opts.status, body: opts.body ?? { errors: [{ message: `HTTP ${opts.status}` }] }, headers: opts.headers, times: opts.times ?? 1 });
  }

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  readonly fetch: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${FAKE_TOKEN}`) {
      return json(401, { errors: [{ message: "Not Authorized" }] });
    }
    const { query, variables = {} } = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
    const failure = this.failures.find((f) => f.times > 0 && f.match.test(query));
    if (failure) {
      failure.times -= 1;
      this.calls.push({ op: `FAILED:${opName(query)}`, variables });
      return json(failure.status, failure.body, failure.headers);
    }
    try {
      const custom = this.resolvers.find((r) => r.match.test(query));
      if (custom) {
        this.calls.push({ op: custom.op, variables });
        return json(200, { data: custom.resolve(variables, this) });
      }
      const data = this.#builtin(query, variables);
      return json(200, { data });
    } catch (err) {
      return json(200, { errors: [{ message: err instanceof Error ? err.message : String(err) }], data: null });
    }
  }) as typeof fetch;

  #builtin(query: string, v: Record<string, unknown>): unknown {
    if (/projectDelete\(/.test(query)) {
      this.calls.push({ op: "projectDelete", variables: v });
      if (!this.projects.delete(String(v.id))) throw new Error("Project not found");
      return { projectDelete: true };
    }
    if (/projects\(workspaceId/.test(query)) {
      this.calls.push({ op: "projects", variables: v });
      const nodes = [...this.projects.values()].filter((p) => p.workspaceId === v.w);
      return { projects: { pageInfo: { hasNextPage: false, endCursor: null }, edges: nodes.map((node) => ({ node: this.projectNode(node) })) } };
    }
    if (/project\(id/.test(query)) {
      this.calls.push({ op: "project", variables: v });
      const p = this.projects.get(String(v.id));
      if (!p) throw new Error("Project not found");
      return { project: this.projectNode(p) };
    }
    throw new Error(`fake Railway: unhandled operation ${opName(query)}`);
  }

  /** Overridden by richer fakes to add environments and services. */
  projectNode(p: FakeProject): Record<string, unknown> {
    return { ...p };
  }

  client(opts: { log?: import("../logger.js").Logger } = {}): RailwayClient {
    return new RailwayClient({ token: new Secret(FAKE_TOKEN), fetch: this.fetch, url: "http://fake.railway.invalid/graphql", log: opts.log });
  }
}

function opName(query: string): string {
  return /\{\s*([A-Za-z0-9_]+)/.exec(query.replace(/^[^{]*/, ""))?.[1] ?? "unknown";
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
