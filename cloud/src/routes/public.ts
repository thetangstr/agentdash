// AgentDash (SC-7, GH #768): the public front-door API (spec §3.6), mounted
// at /api/cloud. www.agentdash.cloud rewrites /api/cloud/* here (vercel.json),
// so the pages and this API share an origin and the session cookie is a
// first-party cookie on www. Nothing here needs, or accepts, the admin bearer.
import { Router, type Request, type Response, type Router as ExpressRouter } from "express";
import type { CloudConfig } from "../config.js";
import { clientIp, fromPrivateNetwork, normaliseIp, socketIp } from "../auth.js";
import type { FrontDoor, Visitor } from "../front-door/service.js";
import { MemoryLimiter } from "../front-door/rate-limit.js";

export const SESSION_COOKIE = "agd_cloud_session";

/**
 * The visitor's address. Through Vercel, the connecting address is Vercel's,
 * so the visitor's comes from the configured header; the connecting address
 * is kept as `proxyIp` so a caller that skips Vercel and forges the header
 * still meets a ceiling on its real address.
 */
export function visitorOf(req: Request, config: Pick<CloudConfig, "clientIpSource" | "privateNetwork" | "frontDoor">): Visitor {
  const connecting = fromPrivateNetwork(req, config) ? socketIp(req) : clientIp(req, config.clientIpSource);
  const header = config.frontDoor.clientIpHeader;
  if (header) {
    const raw = req.headers[header];
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0];
    const ip = normaliseIp(first);
    if (ip) return { ip, proxyIp: connecting };
  }
  return { ip: connecting, proxyIp: null };
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
