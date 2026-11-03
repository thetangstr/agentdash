import "./player.css";
import { useEffect, useRef } from "react";
import { ILLUSTRATION_NOTE, STORY, type Story } from "./story";
import { mount, type SceneLoader } from "./player";

/**
 * The two visual treatments of the same story. Each loader is a dynamic import, so three and the scene
 * are a separate chunk that only this page ever requests, and only when the stage nears the viewport.
 */
export const TREATMENTS = {
  cards: () => import("./scenes/cards"),
  lanes: () => import("./scenes/lanes"),
} satisfies Record<string, SceneLoader>;
export type Treatment = keyof typeof TREATMENTS;

/** The treatment the page ships. The other stays reachable with ?treatment= for review. */
export const SHIPPED_TREATMENT: Treatment = "cards";

export function treatmentFromSearch(search: string): Treatment {
  const asked = new URLSearchParams(search).get("treatment");
  return asked && asked in TREATMENTS ? (asked as Treatment) : SHIPPED_TREATMENT;
}

/** The whole story as text: what screen readers read, and what shows with reduced motion or no WebGL. */
export function StoryText({ story = STORY }: { story?: Story }) {
  const end = story.steps.filter((s) => s.ch < 0).flatMap((s) => s.lines);
  return (
    <div className="tp-still">
      {story.chapters.map((c, i) => {
        const own = story.steps.filter((s) => s.ch === i);
        if (!own.length) return null;
        return (
          <div className="tp-still-ch" key={c.id}>
            <h3>
              <span>{c.n}</span>
              {c.label}
              {c.status ? <em>{c.status}</em> : null}
            </h3>
            <ol>
              {own.map((s) => (
                <li key={s.id}>{s.lines.join(" ")}</li>
              ))}
            </ol>
          </div>
        );
      })}
      {end.length ? <p className="tp-still-end">{end.join(" ")}</p> : null}
    </div>
  );
}

export function StorySection({ treatment = SHIPPED_TREATMENT }: { treatment?: Treatment }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);

  /* client side only: the player builds the stage, clock and caption and loads the scene when near view */
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !stageRef.current || !footRef.current) return;
    const player = mount(root, {
      story: STORY,
      scene: TREATMENTS[treatment],
      stageHost: stageRef.current,
      footHost: footRef.current,
    });
    return () => player.destroy();
  }, [treatment]);

  return (
    <div ref={rootRef} className="hiw-story" data-player data-treatment={treatment}>
      <div ref={stageRef} className="hiw-story__stage" />
      <p className="hiw-story__note">{ILLUSTRATION_NOTE}</p>
      <div ref={footRef} className="hiw-story__foot" />
      <StoryText />
    </div>
  );
}
