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
  writeFile: async (path, data) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, data, { mode: 0o600, flag: "wx" });
  },
}).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`admin: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
