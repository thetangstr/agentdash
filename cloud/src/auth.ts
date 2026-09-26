// AgentDash: guards for the operator surface. Both must pass:
//   1. the caller's IP is on CLOUD_ADMIN_ALLOWED_IPS (empty list = nobody), and
//   2. `Authorization: Bearer <CLOUD_ADMIN_TOKEN>`, compared in constant time.
// The client IP comes from the socket, or from X-Real-IP when
// CLOUD_CLIENT_IP_SOURCE=x-real-ip. Railway's edge overwrites X-Real-IP with
// the real client address (measured in the SC-0 spike), so that source is
// safe on a Railway public domain and nowhere else.
import { isIP } from "node:net";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { CloudConfig } from "./config.js";
import { constantTimeEqual } from "./crypto.js";
import type { Logger } from "./logger.js";

export function clientIp(req: Request, source: CloudConfig["clientIpSource"]): string | null {
  let ip: string | undefined;
  if (source === "x-real-ip") {
    const h = req.headers["x-real-ip"];
    ip = Array.isArray(h) ? h[0] : h;
  } else {
    ip = req.socket.remoteAddress;
  }
  if (!ip) return null;
  ip = ip.trim();
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

export function requireAdmin(config: CloudConfig, log: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req, config.clientIpSource);
    const allowed = ip !== null && config.adminAllowList.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
    if (!allowed) {
      log.warn("admin request refused: ip not allowed", { ip, path: req.path });
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !constantTimeEqual(match[1]!.trim(), config.adminToken.reveal())) {
      log.warn("admin request refused: bad bearer", { ip, path: req.path });
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
