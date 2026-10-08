// AgentDash (SC-7, GH #768): the public front-door API (spec §3.6), mounted
// at /api/cloud. www.agentdash.cloud rewrites /api/cloud/* here (vercel.json),
// so the pages and this API share an origin and the session cookie is a
// first-party cookie on www. Nothing here needs, or accepts, the admin bearer.
import { Router, type Request, type Response, type Router as ExpressRouter } from "express";
import type { CloudConfig } from "../config.js";
import { clientIp, fromPrivateNetwork, normaliseIp, socketIp } from "../auth.js";
import { constantTimeEqual } from "../crypto.js";
import type { FrontDoor, Visitor } from "../front-door/service.js";
import { MemoryLimiter } from "../front-door/rate-limit.js";

export const SESSION_COOKIE = "agd_cloud_session";

export const PROXY_SECRET_HEADER = "x-agentdash-edge-proxy";
export const PROXY_CLIENT_IP_HEADER = "x-agentdash-client-ip";

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The visitor's address (GH #836 security review). Through Vercel the
 * connecting address is Vercel's, so www's routing middleware (repo-root
 * middleware.ts) sends the visitor's in X-AgentDash-Client-IP together with
 * the shared secret in X-AgentDash-Edge-Proxy. The address header is believed
 * only when the secret matches, compared in constant time; with no secret
 * configured it is always ignored. Anyone calling the Railway host directly
 * is keyed by the address they really connect from.
 */
export function visitorOf(req: Request, config: Pick<CloudConfig, "clientIpSource" | "privateNetwork" | "frontDoor">): Visitor {
  const connecting = fromPrivateNetwork(req, config) ? socketIp(req) : clientIp(req, config.clientIpSource);
  const secret = config.frontDoor.proxySecret;
  const presented = headerValue(req, PROXY_SECRET_HEADER);
  if (secret && presented && constantTimeEqual(presented, secret.reveal())) {
    const ip = normaliseIp(headerValue(req, PROXY_CLIENT_IP_HEADER)?.split(",")[0]);
    if (ip) return { ip, viaProxy: true };
  }
  return { ip: connecting, viaProxy: false };
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
    }
  }
  return null;
}

function setSessionCookie(res: Response, token: string, maxAgeSeconds: number, secure: boolean): void {
  res.append(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; Path=/api/cloud; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
}

export function publicRoutes(opts: { frontDoor: FrontDoor; config: Pick<CloudConfig, "clientIpSource" | "privateNetwork" | "frontDoor"> }): ExpressRouter {
  const { frontDoor: fd, config } = opts;
  const router = Router();
  const secureCookie = config.frontDoor.siteUrl.startsWith("https:");
  const slugLimiter = new MemoryLimiter(60, 60_000);
  const verifyLimiter = new MemoryLimiter(30, 3_600_000);

  // No response from the front door is cacheable: they carry per-person state.
  router.use((_req, res, next) => {
    res.setHeader("cache-control", "no-store");
    next();
  });

  // Only JSON bodies: a cross-site form post cannot send one without a preflight.
  router.use((req, res, next) => {
    if (req.method === "POST" && !req.is("application/json")) {
      // Drain the unread body first: answering with it unread makes Node reset the connection.
      const reply = () => void (res.headersSent || res.status(415).json({ error: "send application/json", code: "unsupported_media_type" }));
      if (req.readableEnded) return reply();
      req.on("end", reply).on("error", reply).resume();
      return;
    }
    next();
  });

  const answer = (res: Response, result: { ok: true } | { ok: false; status: number; code: string; error: string }, okStatus = 202) => {
    if (result.ok) res.status(okStatus).json({ ok: true });
    else res.status(result.status).json({ error: result.error, code: result.code });
  };

  router.get("/config", async (_req, res) => {
    res.json(await fd.publicConfig());
  });

  // GH #836 re-review: a deploy check for www's middleware. Answers only
  // whether THIS request carried the proxy secret and a usable client address;
  // never the secret, the address or any other header.
  const proxyCheckLimiter = new MemoryLimiter(30, 60_000);
  router.get("/proxy-check", (req, res) => {
    const visitor = visitorOf(req, config);
    if (!proxyCheckLimiter.take(visitor.ip ?? "unknown")) {
      res.status(429).json({ error: "Too many checks.", code: "rate_limited" });
      return;
    }
    res.json({ trustedProxy: visitor.viaProxy });
  });

  router.get("/slug-available", async (req, res) => {
    const visitor = visitorOf(req, config);
    if (!slugLimiter.take(visitor.ip ?? "unknown")) {
      res.status(429).json({ error: "Too many checks. Slow down a little.", code: "rate_limited" });
      return;
    }
    const slug = typeof req.query.slug === "string" ? req.query.slug.trim().toLowerCase() : "";
    const check = await fd.checkSlug(slug);
    res.json(check.available ? { slug, available: true } : { slug, available: false, reason: check.reason, message: check.message });
  });

  router.post("/signup", async (req, res) => {
    answer(res, await fd.signup((req.body ?? {}) as Record<string, unknown>, visitorOf(req, config)));
  });

  // GH #768: email clients and link scanners fetch links. A GET never uses a
  // token; it sends the browser to the page that does, token in the fragment.
  router.get("/verify", (req, res) => {
    const token = typeof req.query.token === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(req.query.token) ? req.query.token : "";
    res.redirect(302, `${config.frontDoor.siteUrl}/start/verify${token ? `#token=${token}` : ""}`);
  });

  router.post("/verify", async (req, res) => {
    const visitor = visitorOf(req, config);
    if (!verifyLimiter.take(visitor.ip ?? "unknown")) {
      res.status(429).json({ error: "Too many attempts. Try again later.", code: "rate_limited" });
      return;
    }
    const result = await fd.verify((req.body ?? {}).token);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    setSessionCookie(res, result.session.token, result.session.maxAgeSeconds, secureCookie);
    res.json({
      ok: true,
      outcome: result.outcome,
      ...(result.provisioning ? { provisioning: result.provisioning.outcome, reason: result.provisioning.outcome === "waitlisted" ? result.provisioning.reason : null } : {}),
    });
  });

  router.get("/boxes/mine", async (req, res) => {
    const account = await fd.sessionAccount(readCookie(req, SESSION_COOKIE));
    if (!account) {
      res.status(401).json({ error: "Your session has ended. Use Find my workspace to get a new link.", code: "no_session" });
      return;
    }
    res.json(await fd.boxesMine(account.id));
  });

  router.post("/invitation/redeem", async (req, res) => {
    const account = await fd.sessionAccount(readCookie(req, SESSION_COOKIE));
    if (!account) return void res.status(401).json({ error: "Verify your email and sign in to redeem an invitation.", code: "no_session" });
    const result = await fd.redeemInvitation(account.id, (req.body ?? {}).code, visitorOf(req, config));
    if (!result.ok) return void res.status(result.status).json({ error: result.error, code: result.code });
    res.json(result);
  });

  router.post("/resend", async (req, res) => {
    const account = await fd.sessionAccount(readCookie(req, SESSION_COOKIE));
    answer(res, await fd.resend({ email: (req.body ?? {}).email, accountId: account?.id ?? null }, visitorOf(req, config)));
  });

  router.post("/find", async (req, res) => {
    answer(res, await fd.find((req.body ?? {}) as Record<string, unknown>, visitorOf(req, config)));
  });

  router.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  return router;
}
