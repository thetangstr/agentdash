// AgentDash: `pnpm --filter @agentdash/cloud-control admin …`
import { runAdmin } from "./run.js";

runAdmin(process.argv.slice(2), process.env, {
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
  fetch,
}).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`admin: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
