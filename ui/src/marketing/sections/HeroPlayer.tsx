import "./HeroPlayer.css";
import { Suspense, lazy, useEffect, useState } from "react";
import { Play } from "lucide-react";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";

const LazyPlayer = lazy(() => import("../video/HeroStoryPlayer"));

/**
 * Hero use-case story rendered with Remotion's in-page Player. The player
 * bundle loads after first paint; until then (and for visitors who prefer
 * reduced motion, until they press play) a still poster holds the frame.
 */
export function HeroPlayer() {
  const reducedMotion = usePrefersReducedMotion();
  const [wanted, setWanted] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  const shouldRender = mounted && (wanted || !reducedMotion);

  return (
    <figure className="mkt-player" aria-label="Forty-second walkthrough of the AgentDash steward workflow, simulated">
      <div className="mkt-player__frame">
        {shouldRender ? (
          <Suspense fallback={<Poster loading />}>
            <LazyPlayer autoPlay={wanted || !reducedMotion} />
          </Suspense>
        ) : (
          <Poster onPlay={() => setWanted(true)} />
        )}
      </div>
      <figcaption className="mkt-player__caption">
        <span className="mkt-player__tag">Simulated</span>
        Hire a Chief of Staff, direct it from Claude Code, watch it delegate, decide on a guardrail, get the result. 42 seconds, fictional company, no live agents.
      </figcaption>
    </figure>
  );
}

function Poster({ loading, onPlay }: { loading?: boolean; onPlay?: () => void }) {
  return (
    <div className="mkt-poster" aria-hidden={loading ? true : undefined}>
      <div className="mkt-poster__terminal">
        <span className="mkt-poster__dots"><i /><i /><i /></span>
        <div className="mkt-poster__line"><span className="mkt-poster__glyph">&gt;</span> Have Quill prepare Monday's board update.</div>
        <div className="mkt-poster__line mkt-poster__line--tool">⚙ inbox_propose</div>
        <div className="mkt-poster__line mkt-poster__line--dim">← Assign to Quill (Chief of Staff)… Quill drafts; you send. Confirm?</div>
      </div>
      <div className="mkt-poster__card">
        <div className="mkt-poster__card-title">Quill · Chief of Staff</div>
        <div className="mkt-poster__card-sub">Steward: You</div>
      </div>
      {loading ? (
        <div className="mkt-poster__state">Loading the story…</div>
      ) : onPlay ? (
        <button type="button" className="mkt-poster__play" onClick={onPlay}>
          <Play size={18} aria-hidden /> Play the 42-second story
        </button>
      ) : null}
    </div>
  );
}
