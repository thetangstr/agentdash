// AgentDash (AGE-23): a wrong method on a known route is 405, not 404.
//
// Express answers 404 for any request no route handled, including a POST to a
// path that only has a GET. Anyone probing the API then concludes the route
// does not exist and looks in the wrong place (MKT-38). The fix is a fallthrough
// that asks the router which methods DO match the path and, if any do, answers
// 405 with an `Allow` header; unknown paths keep their 404.
//
// The walk mirrors how Express 5 (router@2) dispatches: each layer either owns
// a route (`layer.route`, whose matchers are anchored to the full path) or
// mounts a nested router (`layer.handle.stack`, whose matchers match a prefix
// and hand the remainder down). Matchers are pure functions on the layer, so
// walking them outside a request touches no per-request state.
import type { NextFunction, Request, Response, Router } from "express";

type LayerMatch = { path: string } | false | null | undefined;

interface RouterLayer {
  route?: { methods: Record<string, boolean | undefined> } | null;
  handle?: unknown;
  slash?: boolean;
  matchers?: Array<(path: string) => LayerMatch>;
}

interface RouterLike {
  stack: RouterLayer[];
}

function isRouterLike(value: unknown): value is RouterLike {
  return (
    (typeof value === "function" || (typeof value === "object" && value !== null)) &&
    Array.isArray((value as { stack?: unknown }).stack)
  );
}

/** The prefix a mount layer matched, or null when it does not match at all. */
function matchLayer(layer: RouterLayer, path: string): string | null {
  if (layer.slash) return "";
  for (const matcher of layer.matchers ?? []) {
    const match = matcher(path);
    if (match) return match.path;
  }
  return null;
}

/**
 * Every HTTP method some route under `router` accepts for `path`, uppercase.
 * A route with `all` accepts everything, so it contributes nothing that can
 * be listed and is returned as the wildcard.
 */
export function collectAllowedMethods(router: RouterLike, path: string): { methods: string[]; any: boolean } {
  const methods = new Set<string>();
  let any = false;

  const visit = (current: RouterLike, currentPath: string) => {
    for (const layer of current.stack) {
      if (layer.route) {
        if (matchLayer(layer, currentPath) === null) continue;
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (!enabled) continue;
          if (method === "_all") {
            any = true;
            continue;
          }
          methods.add(method.toUpperCase());
        }
        continue;
      }
      if (!isRouterLike(layer.handle)) continue;
      const prefix = matchLayer(layer, currentPath);
      if (prefix === null) continue;
      // A prefix match must end at a segment boundary, as the router requires.
      const boundary = currentPath[prefix.length];
      if (prefix.length !== 0 && boundary !== undefined && boundary !== "/" && boundary !== ".") continue;
      const remainder = currentPath.slice(prefix.length) || "/";
      visit(layer.handle, remainder.startsWith("/") ? remainder : `/${remainder}`);
    }
  };

  visit(router, path);
  if (methods.has("GET")) methods.add("HEAD");
  return { methods: [...methods].sort(), any };
}

/**
 * The `/api` fallthrough: 405 with `Allow` when the path is known and the
 * method is not, otherwise the 404 the API has always returned.
 */
export function apiFallthrough(router: Router) {
  return (req: Request, res: Response, _next: NextFunction) => {
    const { methods, any } = collectAllowedMethods(router as unknown as RouterLike, req.path);
    const known = methods.length > 0 || any;
    if (known && !any && !methods.includes(req.method.toUpperCase())) {
      res.setHeader("Allow", methods.join(", "));
      res.status(405).json({
        error: "Method not allowed",
        method: req.method.toUpperCase(),
        allow: methods,
      });
      return;
    }
    res.status(404).json({ error: "API route not found" });
  };
}
