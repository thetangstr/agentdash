import "./LayeredDescent.css";
import { useEffect, useRef } from "react";
import { DESCENT_LAYERS } from "./LayeredDescent.layers";
import { useDescentProgress } from "../hooks/useDescentProgress";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";

export function LayeredDescent() {
  const reduced = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // Always subscribe; in reduced-motion mode the value is ignored because CSS
  // overrides the slab positioning (no pin, no perspective, no transforms).
  const progress = useDescentProgress(sectionRef);

  // Active index from progress. Clamp to layer count.
  const lastIndex = DESCENT_LAYERS.length - 1;
  const activeIndex = Math.min(lastIndex, Math.max(0, Math.round(progress * lastIndex)));

  // Write the progress var so CSS can use it for fine-grain effects later.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    el.style.setProperty("--descent-progress", String(progress));
  }, [progress]);

  return (
    <div
      id="layered-descent"
      ref={sectionRef}
      className={`mkt-descent ${reduced ? "mkt-descent--reduced" : ""}`}
      aria-label="The seven layers of the agent stack"
    >
      <div ref={stageRef} className="mkt-descent__stage">
        {!reduced && (
          <ol className="mkt-descent__rail" aria-hidden>
            {DESCENT_LAYERS.map((l, i) => (
              <li
                key={l.number}
                className={i === activeIndex ? "mkt-descent__rail-item--active" : ""}
              >
                {l.number} {i === activeIndex ? l.name : ""}
              </li>
            ))}
          </ol>
        )}

        <div className="mkt-descent__slabs">
          {DESCENT_LAYERS.map((layer, i) => {
            const offset = i - activeIndex;
            const isActive = i === activeIndex;
            return (
              <section
                key={layer.number}
                className={`mkt-descent__slab ${isActive ? "mkt-descent__slab--active" : ""}`}
                style={{ ["--offset" as string]: String(offset) }}
                aria-current={isActive ? "true" : undefined}
              >
                <div className="mkt-descent__slab-edge" aria-hidden />
                <div className="mkt-eyebrow">{layer.number} / 07</div>
                <h3>{layer.name}</h3>
                <p className="mkt-body-lg">{layer.oneLine}</p>
              </section>
            );
          })}
        </div>

        <div className="mkt-descent__panel" aria-hidden>
          <div className="mkt-descent__panel-diagram">
            {DESCENT_LAYERS[activeIndex].diagram}
          </div>
        </div>
      </div>
    </div>
  );
}
