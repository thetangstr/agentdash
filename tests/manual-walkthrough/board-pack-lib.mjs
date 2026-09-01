/**
 * Shared plumbing for the board-pack scenario: acting as a named human, and
 * acting as a harness on that human's own machine.
 *
 * THREE distinct identities matter here, and the scenario is only worth running
 * if they stay separate. Each one is a different credential reaching a
 * different surface, and the server enforces that rather than trusting us:
 *
 *   1. A **person** acts through a better-auth session cookie -- the same
 *      credential a browser holds, so every request is subject to every check a
 *      real click is subject to: role, visibility, CSRF.
 *   2. An **AgentDash agent** acts through an `agent_api_keys` bearer. That is
 *      the ONLY identity `POST /api/mcp` accepts (see `issueAgentKey`).
 *   3. A **harness on someone's laptop** acts through a bridge endpoint token,
 *      which reaches exactly three routes -- `/bridge/poll`, `/bridge/result`,
 *      `/bridge/decline` -- and nothing else, ever. That allowlist lives in
 *      `middleware/auth.ts`, beside where the actor is minted.
 *
 * A first draft of this file assumed (2) and (3) were the same thing, and that
 * a user-scoped `board_api_keys` bearer would serve for the laptop. Both were
 * wrong, and the server said so in plain language rather than half-working.
 */

import { createHmac, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

/** Read an instance's env file without ever printing a value. */
export function readEnv(instance) {
  const text = readFileSync(join(homedir(), ".config", "agentdash", `${instance}.env`), "utf8");
  const out = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function connect(env) {
  return postgres(env.DATABASE_URL, { max: 1 });
}

/**
 * Mint a session for a real user row and return the cookie a browser would send.
 *
 * better-auth signs the cookie as `<token>.<base64 HMAC-SHA256(token)>`. We
 * write the session row ourselves rather than going through sign-in because
 * these are seeded UAT users with no password -- but everything downstream of
 * the cookie is the untouched production path.
 */
export async function actAs(sql, env, userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
  await sql`
    insert into session (id, token, user_id, expires_at, created_at, updated_at)
    values (${randomBytes(16).toString("hex")}, ${token}, ${userId}, ${expiresAt}, now(), now())
  `;
  // Plain base64, padding INTACT. Checked against the running server: base64url,
  // hex, and padding-stripped base64 are all rejected 403, and so is an unsigned
  // token -- so this signature is genuinely verified rather than ignored.
  const signature = createHmac("sha256", env.BETTER_AUTH_SECRET).update(token).digest("base64");
  const name = `paperclip-${env.PAPERCLIP_INSTANCE_ID}.session_token`;
  return `${name}=${token}.${signature}`;
}

/**
 * Issue an AGENT key, which is the only identity `POST /api/mcp` accepts.
 *
 * This was the first thing the scenario got wrong. A user-scoped
 * `board_api_keys` bearer looks like the right credential for "Megan's laptop"
 * and the endpoint refuses it outright:
 *
 *   401 "Connect with an agent key ... The key identifies which agent you are"
 *
 * That refusal is the product being opinionated, and it is worth stating
 * plainly because it shapes the whole scenario: a harness on someone's laptop
 * does not connect AS THAT PERSON, it connects AS AN AGENT. So the laptop side
 * of Megan's work is its own agent with its own key, and the human gate is an
 * approval that agent raises -- not an implicit "well, Megan ran the command".
 *
 * Format and hash mirror `createToken` / `hashToken` in
 * server/src/services/agents.ts.
 */
export async function issueAgentKey(sql, agentId, companyId, name) {
  const plaintext = `pcp_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(plaintext).digest("hex");
  await sql`
    insert into agent_api_keys (agent_id, company_id, name, key_hash, created_at)
    values (${agentId}, ${companyId}, ${name}, ${hash}, now())
  `;
  return plaintext;
}

/** A request made as a person. `Origin` is required: board mutations CSRF-guard. */
export async function asPerson(base, cookie, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      Cookie: cookie,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

/** A JSON-RPC call to the MCP endpoint, as a local harness holding a user key. */
export async function asHarness(base, key, method, params) {
  const response = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const text = await response.text();
  return { status: response.status, raw: text };
}
