// AgentDash (GH #765, SC-4): the edge router's own pages (spec §4.3).
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// The AgentDash brand mark, same geometry as ui/src/components/brand/AgentDashMark.tsx
// and ui/public/favicon.svg. Inlined (and used as a data-URL favicon) because
// the edge answers for hosts that have no workspace to serve /favicon.svg from.
const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="24" height="24" aria-hidden="true">' +
  '<path d="M14 4 H42 L60 22 V50 A10 10 0 0 1 50 60 H14 A10 10 0 0 1 4 50 V14 A10 10 0 0 1 14 4 Z" fill="#0d9488"/>' +
  '<g stroke="#faf9f5" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
  '<line x1="22" y1="42" x2="42" y2="22"/><polyline points="26,22 42,22 42,38"/></g></svg>';
const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(MARK_SVG)}`;

function page(title: string, body: string, opts: { refreshSeconds?: number } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ""}
<title>${esc(title)} · AgentDash</title>
<link rel="icon" href="${FAVICON_HREF}" type="image/svg+xml">
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--accent:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#a3a39c;--accent:#2dd4bf}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:30rem;padding:2rem 1.5rem}.brand{display:flex;align-items:center;gap:.5rem;font-weight:600;color:var(--accent);margin-bottom:1.5rem}
h1{font-size:1.5rem;margin:0 0 .5rem}p{color:var(--muted);margin:.5rem 0}a{color:var(--accent)}
</style></head>
<body><main><div class="brand">${MARK_SVG}<span>AgentDash</span></div><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export function notFoundPage(host: string, findUrl: string): string {
  return page(
    "No workspace here",
    `<p>There is no AgentDash workspace at <strong>${esc(host)}</strong>.</p><p><a href="${esc(findUrl)}">Find your workspace</a></p>`,
  );
}

export function wakingPage(slug: string): string {
  return page("Waking your workspace", `<p>${esc(slug)} was paused while nobody used it. It is starting now and this page will refresh by itself; it usually takes under a minute.</p>`, {
    refreshSeconds: 10,
  });
}

export function deletedPage(slug: string, findUrl: string): string {
  return page("This workspace was deleted", `<p>The workspace ${esc(slug)} no longer exists.</p><p><a href="${esc(findUrl)}">Find your other workspaces</a></p>`);
}

export function notReadyPage(slug: string): string {
  return page("Your workspace is not ready yet", `<p>${esc(slug)} is still being set up. This page will refresh by itself.</p>`, { refreshSeconds: 15 });
}

export function badGatewayPage(slug: string): string {
  return page("Your workspace is not answering", `<p>${esc(slug)} did not answer. It may be restarting; try again in a minute.</p>`, { refreshSeconds: 20 });
}

export function unavailablePage(): string {
  return page("Temporarily unavailable", "<p>AgentDash cannot route this workspace right now. Please try again in a minute.</p>", { refreshSeconds: 30 });
}
