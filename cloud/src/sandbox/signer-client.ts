// AgentDash: thin unix-socket client for signerd (spike R2). Used by tests
// and by any control-plane-in-guest path; the in-image sandbox-ctl.mjs has
// its own copy because the image cannot import this package.
import { connect } from "node:net";

export interface SignerdResponse {
  ok: boolean;
  error?: { code: string; message: string };
  [k: string]: unknown;
}

export function signerRequest(socketPath: string, req: Record<string, unknown>): Promise<SignerdResponse> {
  return new Promise((resolvePromise, reject) => {
    const conn = connect(socketPath);
    let buf = "";
    conn.setEncoding("utf8");
    conn.setTimeout(5_000);
    conn.on("connect", () => conn.write(JSON.stringify(req) + "\n"));
    conn.on("data", (chunk) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      conn.end();
      try {
        resolvePromise(JSON.parse(buf.slice(0, i)) as SignerdResponse);
      } catch (err) {
        reject(err);
      }
    });
    conn.on("error", reject);
    conn.on("timeout", () => reject(new Error("signerd timeout")));
  });
}
