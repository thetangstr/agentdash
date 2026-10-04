// AgentDash (OBS-5, #698): report an adapter child's spawn to the heartbeat.
//
// Some adapters call `runChildProcess` without forwarding `ctx.onSpawn`
// (the vendored Hermes adapter — the built-in `process` adapter forwards it
// directly), so their runs never recorded `process_pid` or
// `process_started_at`, and anything timing the run (the first-output
// deadline, the orphan reaper) or killing it by pid had nothing to go on.
// `runChildProcess` does register the child in the shared `runningProcesses`
// map the moment it spawns, so this watches that map for the run and reports
// the spawn once, within one poll interval.
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
