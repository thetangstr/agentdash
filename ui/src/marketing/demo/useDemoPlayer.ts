import { useCallback, useEffect, useReducer } from "react";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { initialState, nextDelay, reduce, type DemoAction, type DemoState } from "./engine";

/**
 * Drives the pure engine with real time. While the scenario is "running" each
 * event reveals after its scripted delay; everything else waits for a click.
 */
export function useDemoPlayer(initialScenarioId?: string) {
  const [state, dispatch] = useReducer(
    reduce,
    initialScenarioId ? reduce(initialState, { type: "pick", scenarioId: initialScenarioId }) : initialState,
  );
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const delay = nextDelay(state);
    if (delay === null) return;
    const ms = reducedMotion ? Math.min(delay, 120) : delay;
    const t = window.setTimeout(() => dispatch({ type: "tick" }), ms);
    return () => window.clearTimeout(t);
  }, [state, reducedMotion]);

  const skipAhead = useCallback(() => {
    // Reveal everything up to the next point that needs the visitor.
    let s: DemoState = state;
    const actions: DemoAction[] = [];
    for (let i = 0; i < 200 && s.phase === "running"; i++) {
      s = reduce(s, { type: "tick" });
      actions.push({ type: "tick" });
    }
    for (const a of actions) dispatch(a);
  }, [state]);

  return { state, dispatch, skipAhead };
}
