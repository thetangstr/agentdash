// AgentDash: the operator CLI's logic, separate from the process wrapper so
// tests can drive it. It talks to /internal/* with the admin bearer and
// refuses to run at all without one.
import { createHash } from "node:crypto";
import { parseEnvelopeHeader } from "../backups/envelope.js";

export interface AdminIo {
  out: (line: string) => void;
  err: (line: string) => void;
  fetch: typeof fetch;
  /** Reads all of stdin (for `invites import`). */
  readStdin?: () => Promise<string>;
  /** Opens a new file, mode 600, refusing to overwrite (for `backups download`); discard() removes it. */
  openFile?: (path: string) => Promise<{ write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; discard(): Promise<void> }>;
}

export const USAGE = `usage: pnpm --filter @agentdash/cloud-control admin <command>

  settings get [key]         show all settings, or one
  settings set <key> <value> change a setting (true/false, integers, a release tag, or null)
  boxes list [--purpose <p>] list boxes (optionally only customer, demo, canary or internal ones)
  boxes create <slug> <email> [release] [--purpose <p>]
                             create a box for <email> and request provisioning (kill switch and cap apply);
                             --purpose demo boxes are created with hold_upgrades on
  boxes purpose <slug> <p>   set a box's purpose (canary boxes are the first wave of every rollout)
  boxes hold <slug>          hold upgrades for a box (rollouts skip it)
  boxes unhold <slug>        let a box be upgraded again
  boxes upgrade <slug> [release] [--now]
                             upgrade one box to release (default target_release), at the next window
                             opening, or at once with --now
  rollout status             the latest rollout, its waves and the upgrade window
  rollout start [--now]      roll target_release out: canary, then 10% oldest-first, then batches of 5,
                             in the nightly window (--now: start waves outside the window)
  rollout pause [reason]     stop starting new upgrades (sets rollout_paused)
  rollout resume [--now]     clear rollout_paused; failed boxes stay held until unheld; the rest waits for
                             the window again unless --now
  rollout cancel             drop the rollout's remaining planned boxes
  rollout tick               run one orchestrator pass now (it also runs every minute)
  boxes retry <slug>         resume a failed box's provision job at its failed step
  boxes abandon <slug>       give up on a failed or unclaimed box: guarded delete of its Railway project
  fleet edge-backfill        once the edge router is live: give running boxes their edge secret (next deploy)
  fleet status               fleet summary: boxes, health, firing alerts, failed jobs, router 5xx,
                             certificates, spend, idle policy
  box health <slug>          one box: health per path, recent polls, alerts, idle state and next step
  box suspend <slug>         queue a suspend (web deployment removed; data stays)
  box wake <slug>            queue a resume for a suspended box
  alerts list                firing alerts
  alerts test                send a test alert on every configured transport and report each
  invites list               list invitation metadata (purpose, ids, expiry, consumption; never codes/hashes)
  invites import [label] [--allow-short]
                             read codes from stdin (commas or newlines) and store their hashes;
                             codes under 12 characters are refused unless --allow-short
  invites add [label]        make one new code and print it once
  invites add-hosted <label> make one single-use hosted admission code and print it once
  invites revoke <id>        revoke a code
  jobs list [state]          list jobs (all by default; queued, running, succeeded, failed, dead)
  waitlist list [state]      list the waitlist (waiting by default; approved, rejected, all)
  waitlist approve <id>      approve a waiting entry (the person is emailed)
  waitlist approve-next <n>  approve the oldest n waiting entries
  waitlist release           give approved entries their job if provisioning is open now (also runs every minute)
  backups status             off-box backup status for the fleet (last good backup, age, stale boxes)
  backups list <slug>        a box's off-box backups, newest first
  backups run <slug>         back a box up now (runs in the background; check with backups list)
  backups download <id> <file>
                             save a backup's encrypted file; restore it offline with
                             backup-restore decrypt (key machine), then replay (sandbox, no keys): runbook §8
  stripe status              Stripe mode, endpoint secret, shared box key version, boxes behind, event counts
  stripe events [state]      forwarded Stripe events (dead by default: the dead letters; pending, delivered, dropped, all)
  stripe redeliver <evt_id>  put a dead or waiting event back on the queue with a fresh attempt budget
  stripe rotate-box-key [--apply] [--redeploy] [--resume]
                             read the new shared restricted key (rk_…) from stdin and upsert it, with each box's
                             webhook secret, price and trial days, on every box; a DRY RUN unless --apply;
                             --resume (no stdin) re-runs with the stored key to finish an interrupted rotation;
                             --redeploy restarts each box now instead of at its next deploy
  stripe endpoint ensure [--apply]
                             create the account's one webhook endpoint (needs CLOUD_STRIPE_CONTROL_KEY); dry run unless --apply

env: CLOUD_CONTROL_URL (default http://localhost:3200; https required for any non-local host),
     CLOUD_ADMIN_TOKEN (required)`;

/**
 * The admin bearer must never cross a network in clear text (GH #778): plain
 * http is allowed only to this machine (localhost, 127.0.0.0/8, ::1).
 * Returns an error message, or null when the URL is acceptable.
 */
export function checkControlUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `CLOUD_CONTROL_URL is not a valid URL`;
  }
  if (url.username || url.password) return "CLOUD_CONTROL_URL must not carry credentials";
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return `CLOUD_CONTROL_URL must be https (got ${url.protocol})`;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  return local ? null : "refusing to send the admin bearer over plain http to a non-local host; use https";
}

export async function runAdmin(argv: string[], env: NodeJS.ProcessEnv, io: AdminIo): Promise<number> {
  const token = env.CLOUD_ADMIN_TOKEN?.trim();
  if (!token) {
    io.err("refusing to run: CLOUD_ADMIN_TOKEN is not set (the admin bearer is required for every command)");
    return 2;
  }
  const base = (env.CLOUD_CONTROL_URL?.trim() || "http://localhost:3200").replace(/\/+$/, "");
  const bad = checkControlUrl(base);
  if (bad) {
    io.err(`refusing to run: ${bad}`);
    return 2;
  }
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await io.fetch(`${base}/internal${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // keep text
    }
    return { ok: res.ok, status: res.status, json };
  };
  const print = (r: { ok: boolean; status: number; json: unknown }) => {
    if (!r.ok) {
      io.err(`error ${r.status}: ${typeof r.json === "string" ? r.json : JSON.stringify(r.json)}`);
      return 1;
    }
    io.out(JSON.stringify(r.json, null, 2));
    return 0;
  };

  const [group, action, ...rest] = argv;
  if (group === "settings" && action === "get") {
    return print(await call("GET", rest[0] ? `/settings/${encodeURIComponent(rest[0])}` : "/settings"));
  }
  if (group === "settings" && action === "set" && rest.length === 2) {
    return print(await call("PUT", `/settings/${encodeURIComponent(rest[0]!)}`, { value: rest[1] }));
  }
  // AgentDash (GH #861, SC-12 GH #773): --purpose <p> and --now flags.
  const purposeAt = rest.indexOf("--purpose");
  const purpose = purposeAt >= 0 ? rest[purposeAt + 1] : undefined;
  const now = rest.includes("--now");
  const args = rest.filter((a, i) => a !== "--now" && !(purposeAt >= 0 && (i === purposeAt || i === purposeAt + 1)));
  if (purposeAt >= 0 && (!purpose || purpose.startsWith("--"))) {
    io.err("--purpose needs a value: customer, demo, canary or internal");
    return 64;
  }
  if (group === "boxes" && action === "list" && args.length === 0 && !now) {
    return print(await call("GET", purpose ? `/boxes?purpose=${encodeURIComponent(purpose)}` : "/boxes"));
  }
  if (group === "boxes" && action === "create" && (args.length === 2 || args.length === 3) && !now) {
    return print(await call("POST", "/boxes", { slug: args[0], email: args[1], ...(args[2] ? { releaseTag: args[2] } : {}), ...(purpose ? { purpose } : {}) }));
  }
  if (group === "boxes" && action === "purpose" && rest.length === 2) {
    return print(await call("POST", `/boxes/${encodeURIComponent(rest[0]!)}/purpose`, { purpose: rest[1] }));
  }
  if (group === "boxes" && (action === "hold" || action === "unhold") && rest.length === 1) {
    return print(await call("POST", `/boxes/${encodeURIComponent(rest[0]!)}/${action}`));
  }
  if (group === "boxes" && action === "upgrade" && purposeAt < 0 && (args.length === 1 || args.length === 2)) {
    return print(await call("POST", `/boxes/${encodeURIComponent(args[0]!)}/upgrade`, { ...(args[1] ? { releaseTag: args[1] } : {}), now }));
  }
  if (group === "rollout" && purposeAt < 0) {
    if (action === "status" && args.length === 0) return print(await call("GET", "/rollout"));
    if (action === "start" && args.length === 0) return print(await call("POST", "/rollout/start", { now }));
    if (action === "pause" && args.length <= 1) return print(await call("POST", "/rollout/pause", args[0] ? { reason: args[0] } : {}));
    if (action === "resume" && args.length === 0) return print(await call("POST", "/rollout/resume", { now }));
    if ((action === "cancel" || action === "tick") && args.length === 0) return print(await call("POST", `/rollout/${action}`));
  }
  if (group === "boxes" && (action === "retry" || action === "abandon") && rest.length === 1) {
    return print(await call("POST", `/boxes/${encodeURIComponent(rest[0]!)}/${action}`));
  }
  if (group === "fleet" && action === "edge-backfill") return print(await call("POST", "/fleet/edge-backfill"));
  // AgentDash (SC-10, GH #771): fleet monitoring.
  if (group === "fleet" && action === "status" && rest.length === 0) return print(await call("GET", "/fleet/status"));
  if (group === "box" && (action === "health" || action === "suspend" || action === "wake") && rest.length === 1) {
    const slug = encodeURIComponent(rest[0]!);
    return print(action === "health" ? await call("GET", `/boxes/${slug}/health`) : await call("POST", `/boxes/${slug}/${action}`));
  }
  if (group === "alerts" && action === "list" && rest.length === 0) return print(await call("GET", "/alerts"));
  if (group === "alerts" && action === "test" && rest.length === 0) return print(await call("POST", "/alerts/test"));
  if (group === "invites" && action === "list") return print(await call("GET", "/invites"));
  if (group === "invites" && action === "import") {
    const allowShort = rest.includes("--allow-short");
    const args = rest.filter((a) => a !== "--allow-short");
    if (args.length > 1) {
      io.err(USAGE);
      return 64;
    }
    if (!io.readStdin) {
      io.err("invites import reads codes from stdin");
      return 2;
    }
    const codes = await io.readStdin();
    return print(await call("POST", "/invites/import", { codes, ...(args[0] ? { label: args[0] } : {}), ...(allowShort ? { allowShort: true } : {}) }));
  }
  if (group === "invites" && action === "add" && rest.length <= 1) return print(await call("POST", "/invites", rest[0] ? { label: rest[0] } : {}));
  if (group === "invites" && action === "add-hosted" && rest.length === 1) return print(await call("POST", "/invites/hosted", { label: rest[0] }));
  if (group === "invites" && action === "revoke" && rest.length === 1) return print(await call("POST", `/invites/${encodeURIComponent(rest[0]!)}/revoke`));
  if (group === "jobs" && action === "list") {
    return print(await call("GET", `/jobs?state=${encodeURIComponent(rest[0] ?? "all")}`));
  }
  if (group === "waitlist" && action === "list") {
    return print(await call("GET", `/waitlist?state=${encodeURIComponent(rest[0] ?? "waiting")}`));
  }
  if (group === "waitlist" && action === "approve-next" && rest.length === 1) {
    return print(await call("POST", "/waitlist/approve-next", { count: Number(rest[0]) }));
  }
  if (group === "waitlist" && action === "release" && rest.length === 0) return print(await call("POST", "/waitlist/release"));
  if (group === "waitlist" && action === "approve" && rest.length === 1) {
    return print(await call("POST", `/waitlist/${encodeURIComponent(rest[0]!)}/approve`));
  }
  // AgentDash (GH #733): off-box backups.
  if (group === "backups" && action === "status" && rest.length === 0) return print(await call("GET", "/backups"));
  if (group === "backups" && action === "list" && rest.length === 1) return print(await call("GET", `/boxes/${encodeURIComponent(rest[0]!)}/backups`));
  if (group === "backups" && action === "run" && rest.length === 1) return print(await call("POST", `/boxes/${encodeURIComponent(rest[0]!)}/backups`));
  if (group === "backups" && action === "download" && rest.length === 2) {
    if (!io.openFile) {
      io.err("backups download needs a file writer");
      return 2;
    }
    const id = rest[0]!;
    const res = await io.fetch(`${base}/internal/backups/${encodeURIComponent(id)}/download`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok || !res.body) {
      io.err(`error ${res.status}: ${await res.text()}`);
      return 1;
    }
    // Streamed to disk (a backup can be GiBs), hashed on the way, and the
    // envelope header must name the backup asked for: the sealed box does not
    // prove who produced an object, and bucket write access could swap one.
    const file = await io.openFile(rest[1]!);
    const hash = createHash("sha256");
    let head = Buffer.alloc(0);
    let headerChecked = false;
    let size = 0;
    const fail = async (msg: string) => {
      await file.discard();
      io.err(msg);
      return 1;
    };
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        size += chunk.length;
        if (!headerChecked) {
          head = Buffer.concat([head, chunk]);
          const parsed = parseEnvelopeHeader(head);
          if (parsed) {
            headerChecked = true;
            if (parsed.header.backupId !== id) return await fail(`refusing: the stored object is backup ${parsed.header.backupId}, not ${id}`);
          } else if (head.length > 8 + 4 + 64 * 1024) return await fail("refusing: the stored object has no readable backup header");
        }
        await file.write(chunk);
      }
    } catch (err) {
      return await fail(`download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!headerChecked) return await fail("refusing: the stored object is too short to be a backup");
    const want = res.headers.get("x-agentdash-backup-sha256");
    const got = hash.digest("hex");
    if (want && want !== got) return await fail(`download corrupted: sha256 ${got}, expected ${want}`);
    await file.close();
    io.out(`wrote ${size} bytes to ${rest[1]} (sha256 ${got}; still encrypted: open it with the backup-restore tool)`);
    return 0;
  }
  // AgentDash (SC-8, GH #769): Stripe fan-out and the shared box key.
  if (group === "stripe") {
    const flags = new Set(rest.filter((a) => a.startsWith("--")));
    const args = rest.filter((a) => !a.startsWith("--"));
    if (action === "status" && !rest.length) return print(await call("GET", "/stripe/status"));
    if (action === "events" && args.length <= 1 && !flags.size) return print(await call("GET", `/stripe/events?state=${encodeURIComponent(args[0] ?? "dead")}`));
    if (action === "redeliver" && args.length === 1 && !flags.size) return print(await call("POST", `/stripe/events/${encodeURIComponent(args[0]!)}/redeliver`));
    if (action === "endpoint" && args[0] === "ensure" && args.length === 1 && [...flags].every((f) => f === "--apply")) {
      return print(await call("POST", "/stripe/endpoint", { apply: flags.has("--apply") }));
    }
    if (action === "rotate-box-key" && !args.length && [...flags].every((f) => ["--apply", "--redeploy", "--resume"].includes(f))) {
      let key: string | undefined;
      if (!flags.has("--resume")) {
        if (!io.readStdin) {
          io.err("rotate-box-key reads the new key from stdin (or pass --resume to finish with the stored key)");
          return 2;
        }
        key = (await io.readStdin()).trim();
        if (!key) {
          io.err("no key on stdin; pipe the new restricted key in, or pass --resume");
          return 2;
        }
      }
      const r = await call("POST", "/stripe/box-key", { ...(key ? { key } : {}), apply: flags.has("--apply"), redeploy: flags.has("--redeploy") });
      const code = print(r);
      if (code === 0 && !flags.has("--apply")) io.err("dry run: nothing was stored or sent; re-run with --apply");
      if (code === 0 && flags.has("--apply") && (r.json as { failed?: number }).failed) {
        io.err("some boxes failed; fix the cause and run `stripe rotate-box-key --apply --resume` to finish");
        return 1;
      }
      return code;
    }
  }
  io.err(USAGE);
  return 64;
}
