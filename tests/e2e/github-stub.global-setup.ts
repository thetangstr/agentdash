import { createServer } from "node:http";

/**
 * GH #782/#786: one stub of GitHub's REST API for the whole e2e run, on
 * PAPERCLIP_E2E_GITHUB_STUB_PORT. The server validates pasted tokens against
 * it through AGENTDASH_GITHUB_API_URL (see the webServer env below). Started
 * once here so specs running in parallel workers do not fight over the port.
 *
 * Accepts only E2E_GITHUB_TOKEN. Repos under `acme`:
 *   - `readonly`: the token can read but not push
 *   - anything else: push and pull requests allowed
 */
export const E2E_GITHUB_TOKEN = "github_pat_11E2ESTUB00000000000000_playwrightCanaryTokenValue0123";
export const E2E_GITHUB_STUB_PORT = Number(process.env.PAPERCLIP_E2E_GITHUB_STUB_PORT ?? 3297);

export default async function globalSetup() {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${E2E_GITHUB_TOKEN}`) {
      res.statusCode = 401;
      res.end("{}");
      return;
    }
    const match = /^\/repos\/acme\/([A-Za-z0-9._-]+)(\/pulls.*)?$/.exec(req.url ?? "");
    if (!match) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    if (match[2]) {
      res.end("[]");
      return;
    }
    res.end(
      JSON.stringify({
        name: match[1],
        owner: { login: "acme" },
        default_branch: "main",
        private: true,
        permissions: { push: match[1] !== "readonly", pull: true },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(E2E_GITHUB_STUB_PORT, "127.0.0.1", () => resolve());
  });
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
