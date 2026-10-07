// AgentDash: the fake Railway for fleet-upgrade tests (SC-12, GH #773). On
// top of FakeRailwayBoxes it adds what an upgrade touches: deployments that
// capture the image and variables they were made from, deployment(id),
// deploymentRollback, volume snapshots, GHCR digests per tag, and box health
// that reports the release the RUNNING deployment was deployed with.
import { createHash } from "node:crypto";
import { type BoxFakeOptions, type FakeService, type FakeVolume, FakeRailwayBoxes } from "./fake-railway-boxes.js";

export interface DeploySnapshot {
  serviceId: string;
  image: string | null;
  repo?: string | null;
  commit?: string | null;
  variables: Record<string, string>;
  rollbackOf?: string;
}

/** What the box answers on /api/health, given the running deployment; null means use the default. */
export type HealthHook = (svc: FakeService, running: DeploySnapshot) => Record<string, unknown> | { httpStatus: number } | null;

export function digestFor(tag: string): string {
  return `sha256:${createHash("sha256").update(tag).digest("hex")}`;
}

export class FakeRailwayUpgrade extends FakeRailwayBoxes {
  readonly snapshots = new Map<string, DeploySnapshot>();
  readonly backupsTaken: string[] = [];
  /** Statuses the next deployments reach, in order (then opts.deployOutcome, then SUCCESS). */
  readonly nextOutcomes: string[] = [];
  healthHook: HealthHook | null = null;
  /** Rewrites what deployment(id) reports in `meta` (e.g. a different image than the one asked for). */
  metaHook: ((meta: Record<string, unknown>, snap: DeploySnapshot | null) => Record<string, unknown> | null) | null = null;

  constructor(opts: BoxFakeOptions = {}) {
    super(opts);
    this.resolvers.unshift(
      {
        match: /deployment\(id:\$id\)/,
        op: "deployment",
        resolve: (v) => {
          for (const s of this.services.values()) {
            const d = s.deployments.find((x) => x.id === v.id);
            if (d) {
              const snap = this.snapshots.get(d.id);
              const meta = snap?.image ? { image: snap.image } : { repo: snap?.repo ?? null, commitHash: snap?.commit ?? d.commitSha };
              return { deployment: { id: d.id, status: d.status, createdAt: d.createdAt, meta: this.metaHook?.(meta, snap ?? null) ?? meta } };
            }
          }
          return { deployment: null };
        },
      },
      {
        match: /deploymentRollback\(/,
        op: "deploymentRollback",
        resolve: (v) => {
          const snap = this.snapshots.get(String(v.id));
          if (!snap) throw new Error("Deployment not found");
          const s = this.svc(snap.serviceId);
          const id = this.nextId("dep");
          s.deployments.push({ id, status: this.nextOutcomes.shift() ?? "SUCCESS", createdAt: new Date().toISOString(), commitSha: null });
          this.snapshots.set(id, { ...snap, variables: { ...snap.variables }, rollbackOf: String(v.id) });
          return { deploymentRollback: true };
        },
      },
      {
        match: /__type\(name:"VolumeInstanceBackup"\)/,
        op: "backupSchema",
        resolve: () => {
          const scalar = (name: string) => ({ name, type: { kind: "NON_NULL", ofType: { kind: "SCALAR" } } });
          const lock = this.backupLockField();
          return { __type: { fields: [scalar("id"), scalar("name"), scalar("createdAt"), { name: "expiresAt", type: { kind: "SCALAR", ofType: null } }, { name: "scheduleId", type: { kind: "SCALAR", ofType: null } }, ...(lock ? [{ name: lock, type: { kind: "SCALAR", ofType: null } }] : [])] } };
        },
      },
      {
        match: /volumeInstanceBackupList\(/,
        op: "volumeInstanceBackupList",
        resolve: (v, _fake, query) => {
          const vol = this.volOfInstance(v.v);
          // A deletion in flight completes once the volume has been polled enough.
          if (vol.deleting && --vol.deleting.clearsAfterLists <= 0) {
            const { backupId } = vol.deleting;
            vol.backupRecords = vol.backupRecords.filter((b) => b.id !== backupId);
            vol.deleting = null;
          }
          const lock = this.backupLockField();
          const selectsLock = lock !== null && new RegExp(`\\b${lock}\\b`).test(String(query));
          return {
            volumeInstanceBackupList: vol.backupRecords.map((b) => ({ id: b.id, name: b.name, createdAt: b.createdAt, expiresAt: b.expiresAt, scheduleId: b.scheduleId ?? null, ...(selectsLock ? { [lock]: b.locked ?? false } : {}) })),
          };
        },
      },
      {
        match: /volumeInstanceBackupDelete\(/,
        op: "volumeInstanceBackupDelete",
        resolve: (v) => {
          const vol = this.volOfInstance(v.v);
          // Railway allows one backup deletion in progress per volume.
          if (vol.deleting) throw new Error("a backup deletion is already in progress for this volume");
          const b = vol.backupRecords.find((x) => x.id === v.b);
          if (!b) throw new Error("volume instance backup not found");
          if (b.locked) throw new Error(`backup ${b.id} is locked`);
          vol.deleting = { backupId: b.id, clearsAfterLists: this.opts.backupDeleteClearsAfterLists ?? 1 };
          return { volumeInstanceBackupDelete: { workflowId: this.nextId("wf") } };
        },
      },
      {
        match: /volumeInstanceBackupCreate\(/,
        op: "volumeInstanceBackupCreate",
        resolve: (v) => {
          const vol = this.volOfInstance(v.v);
          const limit = this.opts.backupLimit ?? 10;
          if (vol.backupRecords.length >= limit) throw new Error(`Plan limit of ${limit} backups per volume exceeded`);
          vol.backupRecords.push({ id: this.nextId("bak"), name: "Manual", createdAt: new Date().toISOString(), expiresAt: null });
          this.backupsTaken.push(vol.instanceId);
          return { volumeInstanceBackupCreate: { workflowId: this.nextId("wf") } };
        },
      },
    );
  }

  /** The lock field the fake's VolumeInstanceBackup schema exposes (null: none, so Railway's refusal is the only guard). */
  backupLockField(): string | null {
    return this.opts.backupLockField === undefined ? "locked" : this.opts.backupLockField;
  }

  volOfInstance(instanceId: unknown): FakeVolume {
    const vol = [...this.volumes.values()].find((x) => x.instanceId === instanceId);
    if (!vol) throw new Error("Volume instance not found");
    return vol;
  }

  override deploy(s: FakeService, commitSha: string | null): string {
    const id = this.nextId("dep");
    const status = this.nextOutcomes.shift() ?? this.opts.deployOutcome ?? "SUCCESS";
    s.deployments.push({ id, status, createdAt: new Date().toISOString(), commitSha });
    this.snapshots.set(id, { serviceId: s.id, image: s.source?.image ?? null, repo: s.source?.repo ?? null, commit: commitSha, variables: { ...s.variables } });
    return id;
  }

  /** The deployment a service is serving: its newest SUCCESS one. */
  running(s: FakeService): DeploySnapshot | null {
    const d = [...s.deployments].reverse().find((x) => x.status === "SUCCESS");
    return d ? (this.snapshots.get(d.id) ?? null) : null;
  }

  webOf(slug: string): FakeService {
    const p = [...this.projects.values()].find((x) => x.name === `agentdash-box-${slug}`);
    if (!p) throw new Error(`no project for ${slug}`);
    return this.byName(p.id, "web")!;
  }

  /** GHCR (a distinct digest per tag), box health from the running deployment; everything else as FakeRailwayBoxes. */
  readonly upgradeHttp: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /^https:\/\/ghcr\.io\/v2\/.+\/manifests\/(.+)$/.exec(url);
    if (m) {
      this.httpCalls.push(`${init?.method ?? "GET"} ${url}`);
      return (this.opts.ghcrTags ?? []).includes(m[1]!)
        ? new Response(null, { status: 200, headers: { "docker-content-digest": digestFor(m[1]!) } })
        : new Response(null, { status: 404 });
    }
    const h = /^https:\/\/([^/]+)\/api\/health$/.exec(url);
    if (h) {
      this.httpCalls.push(`GET ${url}`);
      const slug = /^([a-z0-9-]+)\.agentdash\.cloud$/.exec(h[1]!)?.[1];
      const project = slug ? [...this.projects.values()].find((p) => p.name === `agentdash-box-${slug}`) : undefined;
      const web = project ? this.byName(project.id, "web") : [...this.services.values()].find((s) => s.domains.includes(h[1]!));
      const run = web ? this.running(web) : null;
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (!web || !run) return json(502, { error: "no deployment" });
      const hooked = this.healthHook?.(web, run) ?? null;
      if (hooked && "httpStatus" in hooked) return json(Number(hooked.httpStatus), { error: "hooked" });
      return json(200, hooked ?? { status: "ok", deploymentMode: "authenticated", hostedBox: true, releaseTag: run.variables.AGENTDASH_RELEASE_TAG });
    }
    return this.http(input, init);
  }) as typeof fetch;
}
