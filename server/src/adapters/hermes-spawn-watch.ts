// AgentDash (OBS-5, #698): report the Hermes child's spawn to the heartbeat.
//
// hermes-paperclip-adapter calls `runChildProcess` without forwarding
// `ctx.onSpawn`, so Hermes runs never recorded `process_pid` or
// `process_started_at`, and anything timing a Hermes run (the first-output
// deadline, the orphan reaper) had to start its clock at the run's queue start.
// `runChildProcess` does register the child in the shared `runningProcesses`
// map the moment it spawns, so this watches that map for the run and reports
// the spawn once, within one poll interval. No patch to the vendored adapter
// (and so no lockfile change) is needed.
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { runningProcesses } from "./utils.js";

type ExecuteContext = Parameters<ServerAdapterModule["execute"]>[0];

const POLL_MS = 200;

export async function withHermesSpawnWatch<T>(
  ctx: Pick<ExecuteContext, "runId" | "onSpawn">,
  run: () => Promise<T>,
  pollMs = POLL_MS,
): Promise<T> {
  const onSpawn = ctx.onSpawn;
  if (typeof onSpawn !== "function") return run();

  let reported = false;
  const check = () => {
    if (reported) return;
    const running = runningProcesses.get(ctx.runId);
    const pid = running?.child.pid;
    if (typeof pid !== "number" || pid <= 0) return;
    reported = true;
    void onSpawn({
      pid,
      processGroupId: running!.processGroupId ?? null,
      startedAt: new Date().toISOString(),
    }).catch(() => {
      // Metadata only; never fail the run over it.
    });
  };
  const timer = setInterval(check, pollMs);
  timer.unref?.();
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}
