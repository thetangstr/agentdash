// AgentDash (GH #765, SC-4): the edge router's own pages (spec §4.3).
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string, opts: { refreshSeconds?: number } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ""}
<title>${esc(title)} · AgentDash</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--accent:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#a3a39c;--accent:#2dd4bf}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:30rem;padding:2rem 1.5rem}.brand{font-weight:600;color:var(--accent);margin-bottom:1.5rem}
h1{font-size:1.5rem;margin:0 0 .5rem}p{color:var(--muted);margin:.5rem 0}a{color:var(--accent)}
</style></head>
<body><main><div class="brand">AgentDash</div><h1>${esc(title)}</h1>${body}</main></body></html>`;
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
