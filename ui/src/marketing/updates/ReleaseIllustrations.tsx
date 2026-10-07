import { useEffect, useState } from "react";
import { useLiveAutoFollow } from "../../hooks/useLiveAutoFollow";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import "./ReleaseIllustrations.css";

export function TeamSidebar() {
  return (
    <figure className="mkt-release-demo mkt-release-demo--teams" aria-label="Team sidebar example">
      <figcaption>Simulated illustration · Your team</figcaption>
      <div className="mkt-team-example">
        <div className="mkt-team-example__heading"><span className="mkt-team-example__avatar">C</span><strong>Chief of Staff</strong><span>Team</span></div>
        <details open><summary>Research team <span>2 agents</span></summary>
          <ul><li><span className="mkt-team-example__dot" />Researcher</li><li><span className="mkt-team-example__dot" />Analyst</li></ul>
        </details>
        <details open><summary>Content team <span>1 agent</span></summary>
          <p className="mkt-team-example__note">Writer is open below.</p>
        </details>
        <div className="mkt-team-example__selected" aria-current="true"><span className="mkt-team-example__avatar">W</span><strong>Writer</strong><span>Viewing</span></div>
      </div>
      <p className="mkt-release-demo__hint">Collapse either team. The agent you are viewing stays in sight.</p>
    </figure>
  );
}

const OUTPUT = [
  ["09:41", "Request received. Preparing the update."],
  ["09:42", "Research notes gathered for review."],
  ["09:43", "Writer is working on the first draft."],
  ["09:44", "Draft prepared. Checking the source notes."],
  ["09:45", "Review comments added to the draft."],
  ["09:46", "Revision prepared for a human decision."],
  ["09:47", "Update ready to read."],
];

export function FollowingTranscript() {
  const reducedMotion = usePrefersReducedMotion();
  const [count, setCount] = useState(3);
  const [playing, setPlaying] = useState(false);
  // Use the product's follow rule so this illustration behaves like the run pane.
  const follow = useLiveAutoFollow({ live: true, resetKey: "marketing-transcript", contentKey: count });
  const finished = count === OUTPUT.length;
  useEffect(() => {
    if (!playing || reducedMotion || finished) return;
    const timer = window.setTimeout(() => setCount((value) => value + 1), 1100);
    return () => window.clearTimeout(timer);
  }, [playing, reducedMotion, finished, count]);
  function readEarlier() {
    follow.holdFollow();
    follow.getContainer()?.scrollTo({ top: 0, behavior: "auto" });
  }
  function advance() {
    if (finished) { setCount(3); setPlaying(!reducedMotion); }
    else if (reducedMotion) setCount((value) => value + 1);
    else setPlaying((value) => !value);
  }
  return (
    <figure className="mkt-release-demo mkt-release-demo--transcript" aria-label="Transcript following example">
      <figcaption>Simulated illustration · Live transcript</figcaption>
      <div className="mkt-transcript-example__status" role="status">{follow.isFollowing ? "Following latest" : "Following paused"}<span>{finished ? "Example complete" : "Scripted output"}</span></div>
      <div ref={follow.scrollerRef} className="mkt-transcript-example__pane" role="region" aria-label="Simulated transcript, scroll to read earlier output" tabIndex={0}>
        <div ref={follow.contentRef}>
          {OUTPUT.slice(0, count).map(([time, line]) => <p key={time}><time>{time}</time><span>{line}</span></p>)}
          <div ref={follow.anchorRef} />
        </div>
      </div>
      <div className="mkt-release-demo__controls">
        <button type="button" onClick={advance}>{finished ? "Replay output" : reducedMotion ? "Next output" : playing ? "Pause output" : "Play output"}</button>
        {follow.isFollowing ? <button type="button" onClick={readEarlier}>Read earlier</button> : <button type="button" onClick={follow.jumpToLatest}>Jump to latest</button>}
      </div>
      <p className="mkt-release-demo__hint">Play output, then scroll up or choose Read earlier. New lines arrive without moving your place.</p>
    </figure>
  );
}
