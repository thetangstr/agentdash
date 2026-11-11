// AgentDash: serve only the built public UI for marketing browser checks.
// No database, model, company, credential or production endpoint is used.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../ui/dist");
const port = Number(process.env.AGENTDASH_MARKETING_PREVIEW_PORT || 3398);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3100, 3101, 3102, 3120, 3199, 3300].includes(port)) throw new Error("Refusing an invalid or live-instance port");
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url || "/", `http://127.0.0.1:${port}`).pathname);
    if (pathname === "/api" || pathname.startsWith("/api/")) { response.writeHead(503, { "Content-Type": "application/json" }); response.end('{"error":"No backend in the isolated marketing preview"}'); return; }
    const target = path.resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
    const file = path.extname(pathname) ? target : path.join(root, "index.html");
    const body = await readFile(file); response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }); response.end(body);
  } catch { response.writeHead(404); response.end("Not found"); }
});
server.listen(port, "127.0.0.1", () => console.log(`Isolated marketing preview: http://127.0.0.1:${port}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
