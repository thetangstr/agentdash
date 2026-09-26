// AgentDash: a stateful fake of the Railway API a box provision touches
// (projects, environments, services, volumes, variables, domains, service
// settings, deployments, snapshots, deployment triggers), plus fake GHCR,
// GitHub and box-health endpoints on the same fetch (GH #763).
import { FakeRailway, type FakeProject } from "./fake-railway.js";

export interface FakeService {
  id: string;
  projectId: string;
  name: string;
  source: { image?: string | null; repo?: string | null } | null;
  settings: Record<string, unknown>;
  variables: Record<string, string>;
  domains: string[];
  deployments: Array<{ id: string; status: string; createdAt: string; commitSha: string | null }>;
  triggers: string[];
}

export interface FakeVolume {
  id: string;
  instanceId: string;
  projectId: string;
  serviceId: string;
  mountPath: string;
  backups: string[];
}

export interface BoxFakeOptions {
  /** Tags GHCR has an image for (e.g. "v2026.930.0"). */
  ghcrTags?: string[];
  /** Tag → commit on GitHub. */
  githubTags?: Record<string, string>;
  /** Setting a source starts a deployment by itself (the Hobby behaviour). */
  autoDeployOnSource?: boolean;
  /** Status new deployments reach. */
  deployOutcome?: "SUCCESS" | "FAILED";
  /** What the box answers on /api/health once deployed. */
  health?: Record<string, unknown>;
}

export class FakeRailwayBoxes extends FakeRailway {
  readonly services = new Map<string, FakeService>();
  readonly volumes = new Map<string, FakeVolume>();
  readonly envs = new Map<string, string>(); // projectId → environment id
  readonly httpCalls: string[] = [];
  opts: BoxFakeOptions;
  failVariablesRead: "names" | "values" | null = null;

  constructor(opts: BoxFakeOptions = {}) {
    super();
    this.opts = opts;
    const on = (match: RegExp, op: string, resolve: (v: Record<string, unknown>) => unknown) =>
      this.resolvers.push({ match, op, resolve: (v) => resolve(v) });

    on(/projectCreate\(/, "projectCreate", (v) => {
      const i = v.i as { name: string; workspaceId: string; description: string };
      const p = this.addProject({ name: i.name, workspaceId: i.workspaceId, description: i.description });
      this.envs.set(p.id, this.nextId("env"));
      return { projectCreate: { id: p.id } };
    });
    on(/serviceCreate\(/, "serviceCreate", (v) => {
      const i = v.i as { projectId: string; name: string };
      const s: FakeService = { id: this.nextId("svc"), projectId: i.projectId, name: i.name, source: null, settings: {}, variables: {}, domains: [], deployments: [], triggers: [] };
      this.services.set(s.id, s);
      return { serviceCreate: { id: s.id } };
    });
    on(/volumeCreate\(/, "volumeCreate", (v) => {
      const i = v.i as { projectId: string; serviceId: string; mountPath: string };
      const vol: FakeVolume = { id: this.nextId("vol"), instanceId: this.nextId("volinst"), projectId: i.projectId, serviceId: i.serviceId, mountPath: i.mountPath, backups: [] };
      this.volumes.set(vol.id, vol);
      return { volumeCreate: { id: vol.id } };
    });
    on(/variables\(projectId:\$p, environmentId:\$e, serviceId:\$s, unrendered:true\)/, "variableNames", (v) => {
      if (this.failVariablesRead === "names") throw new Error("boom");
      return { variables: { ...this.svc(v.s).variables } };
    });
    on(/variables\(projectId:\$p, environmentId:\$e, serviceId:\$s\)/, "variableValues", (v) => {
      if (this.failVariablesRead === "values") throw new Error("boom");
      return { variables: { ...this.svc(v.s).variables } };
    });
    on(/variableCollectionUpsert\(/, "variableCollectionUpsert", (v) => {
      const i = v.i as { serviceId: string; variables: Record<string, string>; skipDeploys: boolean };
      if (i.skipDeploys !== true) throw new Error("test: upsert without skipDeploys");
      Object.assign(this.svc(i.serviceId).variables, i.variables);
      return { variableCollectionUpsert: true };
    });
    on(/domains\(projectId/, "domains", (v) => ({ domains: { serviceDomains: this.svc(v.s).domains.map((domain) => ({ domain })) } }));
    on(/serviceDomainCreate\(/, "serviceDomainCreate", (v) => {
      const i = v.i as { serviceId: string };
      const s = this.svc(i.serviceId);
      const domain = `${s.name}-${s.id}.up.railway.app`;
      s.domains.push(domain);
      return { serviceDomainCreate: { domain } };
    });
    on(/serviceInstanceUpdate\(/, "serviceInstanceUpdate", (v) => {
      const s = this.svc(v.s);
      const i = { ...(v.i as Record<string, unknown>) };
      const source = i.source as FakeService["source"] | undefined;
      delete i.source;
      Object.assign(s.settings, i);
      if (source) {
        s.source = source;
        if (source.repo) s.triggers.push(this.nextId("trigger"));
        if (this.opts.autoDeployOnSource) this.deploy(s, null);
      }
      return { serviceInstanceUpdate: true };
    });
    on(/deployments\(first:1/, "deployments", (v) => {
      const i = v.i as { serviceId: string };
      const d = this.svc(i.serviceId).deployments.at(-1);
      return { deployments: { edges: d ? [{ node: { id: d.id, status: d.status, createdAt: d.createdAt } }] : [] } };
    });
    on(/serviceInstanceDeployV2\(/, "serviceInstanceDeployV2", (v) => {
      const s = this.svc(v.s);
      if (!s.source) throw new Error("Deployment not found");
      return { serviceInstanceDeployV2: this.deploy(s, (v.c as string | null) ?? null) };
    });
    on(/volumeInstanceBackupScheduleUpdate\(/, "volumeInstanceBackupScheduleUpdate", (v) => {
      const vol = [...this.volumes.values()].find((x) => x.instanceId === v.v);
      if (!vol) throw new Error("Volume instance not found");
      vol.backups = [...(v.k as string[])];
      return { volumeInstanceBackupScheduleUpdate: true };
    });
    on(/deploymentTriggers\(projectId/, "deploymentTriggers", (v) => ({
      deploymentTriggers: { edges: this.svc(v.s).triggers.map((id) => ({ node: { id } })) },
    }));
    on(/deploymentTriggerDelete\(/, "deploymentTriggerDelete", (v) => {
      for (const s of this.services.values()) s.triggers = s.triggers.filter((t) => t !== v.id);
      return { deploymentTriggerDelete: true };
    });
    // project(id) with the full detail the provisioner reads.
    on(/project\(id:\$id\)\{ id name description workspaceId\s+environments/, "projectDetail", (v) => {
      const p = this.projects.get(String(v.id));
      if (!p) throw new Error("Project not found");
      return { project: this.detail(p) };
    });
  }

  svc(id: unknown): FakeService {
    const s = this.services.get(String(id));
    if (!s) throw new Error("Service not found");
    return s;
  }

  deploy(s: FakeService, commitSha: string | null): string {
    const id = this.nextId("dep");
    s.deployments.push({ id, status: this.opts.deployOutcome ?? "SUCCESS", createdAt: new Date().toISOString(), commitSha });
    return id;
  }

  servicesOf(projectId: string): FakeService[] {
    return [...this.services.values()].filter((s) => s.projectId === projectId);
  }

  byName(projectId: string, name: string): FakeService | undefined {
    return this.servicesOf(projectId).find((s) => s.name === name);
  }

  detail(p: FakeProject) {
    const env = this.envs.get(p.id) ?? "env-missing";
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      workspaceId: p.workspaceId,
      environments: { edges: [{ node: { id: env, name: "production" } }] },
      services: {
        edges: this.servicesOf(p.id).map((s) => ({
          node: { id: s.id, name: s.name, serviceInstances: { edges: [{ node: { environmentId: env, source: { image: s.source?.image ?? null, repo: s.source?.repo ?? null } } }] } },
        })),
      },
      volumes: {
        edges: [...this.volumes.values()]
          .filter((v) => v.projectId === p.id)
          .map((v) => ({ node: { id: v.id, volumeInstances: { edges: [{ node: { id: v.instanceId, volumeId: v.id, serviceId: v.serviceId, mountPath: v.mountPath, environmentId: env } }] } } })),
      },
    };
  }

  /** GHCR, GitHub and box health, for the provisioner's `fetch` dependency. */
  readonly http: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    this.httpCalls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    if (url.startsWith("https://ghcr.io/token")) return json(200, { token: "anon" });
    const m = /^https:\/\/ghcr\.io\/v2\/.+\/manifests\/(.+)$/.exec(url);
    if (m) {
      return (this.opts.ghcrTags ?? []).includes(m[1]!)
        ? new Response(null, { status: 200, headers: { "docker-content-digest": `sha256:${"ab".repeat(32)}` } })
        : new Response(null, { status: 404 });
    }
    const g = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/git\/ref\/tags\/(.+)$/.exec(url);
    if (g) {
      const sha = this.opts.githubTags?.[g[1]!];
      return sha ? json(200, { object: { sha, type: "commit" } }) : json(404, { message: "Not Found" });
    }
    const h = /^https:\/\/([^/]+)\/api\/health$/.exec(url);
    if (h) {
      const web = [...this.services.values()].find((s) => s.domains.includes(h[1]!));
      if (!web || !web.deployments.some((d) => d.status === "SUCCESS")) return json(502, { error: "no deployment" });
      return json(200, this.opts.health ?? { status: "ok", deploymentMode: "authenticated", hostedBox: true });
    }
    return json(599, { error: `test fetch: unexpected ${url}` });
  }) as typeof fetch;
}
