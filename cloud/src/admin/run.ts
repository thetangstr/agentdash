// AgentDash: the operator CLI's logic, separate from the process wrapper so
// tests can drive it. It talks to /internal/* with the admin bearer and
// refuses to run at all without one.
export interface AdminIo {
  out: (line: string) => void;
  err: (line: string) => void;
  fetch: typeof fetch;
}

export const USAGE = `usage: pnpm --filter @agentdash/cloud-control admin <command>

  settings get [key]         show all settings, or one
  settings set <key> <value> change a setting (true/false, integers, a release tag, or null)
  boxes list                 list boxes
  waitlist list [state]      list the waitlist (waiting by default; approved, rejected, all)
  waitlist approve <id>      approve a waiting entry

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
  if (group === "boxes" && action === "list") return print(await call("GET", "/boxes"));
  if (group === "waitlist" && action === "list") {
    return print(await call("GET", `/waitlist?state=${encodeURIComponent(rest[0] ?? "waiting")}`));
  }
  if (group === "waitlist" && action === "approve" && rest.length === 1) {
    return print(await call("POST", `/waitlist/${encodeURIComponent(rest[0]!)}/approve`));
  }
  io.err(USAGE);
  return 64;
}
