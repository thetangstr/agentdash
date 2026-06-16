import { createHash } from "node:crypto";

const TRACKING = /^(utm_|fbclid|gclid|ref$|ref_)/i;

export function sourceUrlHash(url: string): string {
  let normalized = url.trim().toLowerCase();
  try {
    const u = new URL(normalized);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hash = "";
    normalized = u.toString();
  } catch {
    /* fall back to raw lowercase string */
  }
  return createHash("sha256").update(normalized).digest("hex");
}

export function canonicalEventHash(core: Record<string, unknown>): string {
  const canonical = JSON.stringify(core, Object.keys(core).sort());
  return createHash("sha256").update(canonical).digest("hex");
}
