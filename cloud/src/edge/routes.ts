// AgentDash (GH #765, SC-4): the edge router's route table (spec §4.3).
// In memory, refreshed every few seconds from the `edge_routes` view (read
// with the router's own read-only role), with an on-miss lookup so a box
// routes the moment it is published, and the last good table kept whenever
// Postgres cannot be reached. Edge secrets are decrypted with CLOUD_DATA_KEY
// and held as Secrets, so no log line can print one.
import type postgres from "postgres";
import { decryptField, type DataKeyring } from "../crypto.js";
import type { Logger } from "../logger.js";
import { Secret } from "../secret.js";

export interface RawRoute {
  slug: string;
  state: string;
  upstream_host: string | null;
  edge_secret_enc: string | null;
}

export interface EdgeRoute {
  slug: string;
  state: string;
  upstreamHost: string | null;
  edgeSecret: Secret | null;
}

export interface RouteSource {
  all(): Promise<RawRoute[]>;
  one(slug: string): Promise<RawRoute | null>;
}

export function pgRouteSource(sql: postgres.Sql): RouteSource {
  return {
    all: async () => (await sql<RawRoute[]>`select slug, state, upstream_host, edge_secret_enc from edge_routes`) as unknown as RawRoute[],
    one: async (slug) => {
      const rows = await sql<RawRoute[]>`select slug, state, upstream_host, edge_secret_enc from edge_routes where slug = ${slug}`;
      return (rows[0] as RawRoute | undefined) ?? null;
    },
  };
}

export interface RouteLookup {
  lookup(slug: string): Promise<EdgeRoute | null>;
}

export class RouteTable implements RouteLookup {
  #routes = new Map<string, EdgeRoute>();
  #misses = new Map<string, number>();
  #lastRefresh = 0;
  readonly #source: RouteSource;
  readonly #keys: DataKeyring;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #missTtlMs: number;

  constructor(opts: { source: RouteSource; dataKeys: DataKeyring; log: Logger; now?: () => number; missTtlMs?: number }) {
    this.#source = opts.source;
    this.#keys = opts.dataKeys;
    this.#log = opts.log.child({ component: "edge-routes" });
    this.#now = opts.now ?? Date.now;
    this.#missTtlMs = opts.missTtlMs ?? 5_000;
  }

  get size(): number {
    return this.#routes.size;
  }

  /** Milliseconds since the last successful refresh (Infinity before the first). */
  get ageMs(): number {
    return this.#lastRefresh ? this.#now() - this.#lastRefresh : Number.POSITIVE_INFINITY;
  }

  #toRoute(r: RawRoute): EdgeRoute {
    let edgeSecret: Secret | null = null;
    if (r.edge_secret_enc) {
      try {
        edgeSecret = new Secret(decryptField(this.#keys, r.edge_secret_enc, "boxes.edge_secret_enc"));
      } catch (err) {
        this.#log.error("could not decrypt a box's edge secret; the box is not routable", { slug: r.slug, err });
      }
    }
    return { slug: r.slug, state: r.state, upstreamHost: r.upstream_host, edgeSecret };
  }

  /** Reload the whole table. On failure the last good table stays in use. */
  async refresh(): Promise<boolean> {
    try {
      const rows = await this.#source.all();
      const next = new Map<string, EdgeRoute>();
      for (const r of rows) next.set(r.slug, this.#toRoute(r));
      this.#routes = next;
      this.#misses.clear();
      this.#lastRefresh = this.#now();
      return true;
    } catch (err) {
      this.#log.warn("route table refresh failed; serving the last good table", { err, routes: this.#routes.size });
      return false;
    }
  }

  async lookup(slug: string): Promise<EdgeRoute | null> {
    const hit = this.#routes.get(slug);
    if (hit) return hit;
    const missedAt = this.#misses.get(slug);
    if (missedAt !== undefined && this.#now() - missedAt < this.#missTtlMs) return null;
    try {
      const row = await this.#source.one(slug);
      if (!row) {
        if (this.#misses.size > 10_000) this.#misses.clear();
        this.#misses.set(slug, this.#now());
        return null;
      }
      const route = this.#toRoute(row);
      this.#routes.set(slug, route);
      return route;
    } catch (err) {
      this.#log.warn("on-miss route lookup failed", { slug, err });
      return null;
    }
  }
}
