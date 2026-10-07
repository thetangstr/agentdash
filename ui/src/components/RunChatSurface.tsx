import { memo, useMemo, useState } from "react";
import type { TranscriptEntry } from "../adapters";
import type { LiveRunForIssue } from "../api/heartbeats";
import { IssueChatThread } from "./IssueChatThread";
import type { IssueChatLinkedRun } from "../lib/issue-chat-messages";

const EMPTY_COMMENTS: [] = [];
const EMPTY_TIMELINE_EVENTS: [] = [];
const EMPTY_LIVE_RUNS: [] = [];
const EMPTY_LINKED_RUNS: [] = [];
const handleEmbeddedAdd = async () => {};

function isRunActive(run: LiveRunForIssue) {
  return run.status === "queued" || run.status === "running";
}

interface RunChatSurfaceProps {
  run: LiveRunForIssue;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  companyId?: string | null;
  /**
   * AgentDash (chat auto-follow): render the surface inside its own scrolling
   * pane with these classes. A live run then opens on its latest output,
   * follows it while the viewer is at the bottom, and offers Jump to latest.
   * Without it (an inline surface) nothing scrolls.
   */
  scrollPaneClassName?: string;
}

export const RunChatSurface = memo(function RunChatSurface({
  run,
  transcript,
  hasOutput,
  companyId,
  scrollPaneClassName,
}: RunChatSurfaceProps) {
  const [scrollPane, setScrollPane] = useState<HTMLDivElement | null>(null);
  const active = isRunActive(run);
  const liveRuns = useMemo(() => (active ? [run] : EMPTY_LIVE_RUNS), [active, run]);
  const linkedRuns = useMemo<IssueChatLinkedRun[]>(
    () =>
      active
        ? EMPTY_LINKED_RUNS
        : [{
            runId: run.id,
            status: run.status,
            agentId: run.agentId,
            agentName: run.agentName,
            createdAt: run.createdAt,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          }],
    [active, run],
  );
  const transcriptsByRunId = useMemo(
    () => new Map([[run.id, transcript as readonly TranscriptEntry[]]]),
    [run.id, transcript],
  );

  const thread = (
    <IssueChatThread
      comments={EMPTY_COMMENTS}
      linkedRuns={linkedRuns}
      timelineEvents={EMPTY_TIMELINE_EVENTS}
      liveRuns={liveRuns}
      companyId={companyId}
      onAdd={handleEmbeddedAdd}
      showComposer={false}
      showJumpToLatest={false}
      variant="embedded"
      emptyMessage={active ? "Waiting for run output..." : "No run output captured."}
      enableLiveTranscriptPolling={false}
      transcriptsByRunId={transcriptsByRunId}
      hasOutputForRun={(runId) => runId === run.id && hasOutput}
      includeSucceededRunsWithoutOutput
      scrollPane={scrollPaneClassName ? scrollPane : null}
    />
  );
  if (!scrollPaneClassName) return thread;
  return (
    <div ref={setScrollPane} data-testid="run-chat-scroll-pane" className={scrollPaneClassName}>
      {thread}
    </div>
  );
});
