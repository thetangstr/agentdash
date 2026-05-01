// AgentDash: naive in-memory IP rate limit (AGE-104).
// Resets on cold start; acceptable for v0 of the /solve survey.

const HITS_PER_HOUR = 5;
const recentHits = new Map<string, number[]>();

export function rateLimit(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const hits = (recentHits.get(ip) ?? []).filter((t) => t > windowStart);
  if (hits.length >= HITS_PER_HOUR) {
    recentHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  recentHits.set(ip, hits);
  return true;
}

// Test helper. Not used at runtime.
export function _resetRateLimitForTests() {
  recentHits.clear();
}
