// AgentDash: `pnpm --filter @agentdash/cloud-control admin …`
import { runAdmin } from "./run.js";

runAdmin(process.argv.slice(2), process.env, {
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
  fetch,
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
  openFile: async (path) => {
    const { open, rm } = await import("node:fs/promises");
    const fh = await open(path, "wx", 0o600);
    let closed = false;
    const close = async () => {
      if (!closed) await fh.close();
      closed = true;
    };
    return {
      write: async (chunk) => void (await fh.write(chunk)),
      close,
      discard: async () => {
        await close();
        await rm(path, { force: true });
      },
    };
  },
}).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`admin: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
