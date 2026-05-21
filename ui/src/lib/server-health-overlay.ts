const PUBLIC_STATIC_ROUTES = new Set([
  "/",
  "/about",
  "/assess",
  "/consulting",
  "/cos-pilot-deck",
]);

function normalizePathname(pathname: string) {
  const pathOnly = pathname.split(/[?#]/, 1)[0] || "/";
  const rooted = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  return rooted.length > 1 ? rooted.replace(/\/+$/, "") : "/";
}

export function shouldShowServerUnreachableOverlay(pathname: string) {
  return !PUBLIC_STATIC_ROUTES.has(normalizePathname(pathname));
}
