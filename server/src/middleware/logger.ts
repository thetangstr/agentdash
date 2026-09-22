import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import { redactQueryObject, redactSensitive, redactUrlQuery } from "./redact-sensitive.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

/**
 * Log-line fields that must never reach disk in the clear.
 *
 * The trap this closes: customProps below attaches the WHOLE request body to
 * every response >= 400 — deliberately, because the body is usually what
 * explains the failure. But a failed sign-in is a >= 400 response whose body
 * IS the attempted password, so before this list every mistyped password
 * landed in ~/Library/Logs/agentdash/*.log in cleartext, world-readable, and
 * survived into the rotation copies. Found 2026-08-17 with real attempts in
 * the file. Treat any password ever mistyped before this shipped as disclosed.
 *
 * The body reaches the log line on two paths — the error-context capture and
 * the raw req.body fallback — but both attach it as the same top-level
 * `reqBody` property, so one set of paths covers both.
 */
const SECRET_BODY_FIELDS = ["password", "newPassword", "currentPassword", "token"];
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  ...SECRET_BODY_FIELDS.map((field) => `reqBody.${field}`),
];

export const logger = pino({
  level: "debug",
  redact: LOG_REDACT_PATHS,
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  serializers: {
    // AGE-83: the `req.url` pino-http puts on every log line is the raw
    // request URL, so an OAuth callback's `?code=` landed on disk verbatim.
    // TRAP (verified in the AGE-80 probe): pino-http wraps custom
    // serializers in wrapRequestSerializer, so this receives the
    // ALREADY-SERIALIZED req object ({method,url,headers,remoteAddress,
    // remotePort}), not the Express request. Spread-copy keeps the
    // serialized shape and only rewrites the URL.
    req(obj) {
      return { ...obj, url: redactUrlQuery(obj?.url) };
    },
  },
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    // AGE-83: pino-http routes ONLY err/>=500 to customErrorMessage, so 4xx
    // lines carry their URL through THIS message — both messages must scrub.
    return `${req.method} ${redactUrlQuery(req.url)} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${redactUrlQuery(req.url)} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: redactSensitive(ctx.reqBody),
          reqParams: redactSensitive(ctx.reqParams),
          // AGE-83: reqQuery is the query channel — the query-key list with
          // the suffix rule, not the body list. reqBody/reqParams stay on
          // the body list on purpose (a body key named `code` is NOT
          // newly redacted; pinned by regression test).
          reqQuery: redactQueryObject(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = redactSensitive(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = redactSensitive(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = redactQueryObject(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
