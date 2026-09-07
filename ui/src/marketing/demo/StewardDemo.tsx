import "./StewardDemo.css";
import { FastForward, RotateCcw } from "lucide-react";
import { availableActions, boardView, terminalView } from "./engine";
import { SCENARIOS, findScenario } from "./scenarios";
import { BoardPane } from "./BoardPane";
import { TerminalPane } from "./TerminalPane";
import { useDemoPlayer } from "./useDemoPlayer";

const STEPS = [
  { n: 1, label: "Direct", hint: "from your terminal" },
  { n: 2, label: "Delegate", hint: "Quill hands out the work" },
  { n: 3, label: "Decide", hint: "a guardrail waits on you" },
  { n: 4, label: "Result", hint: "attributed, sourced, logged" },
] as const;

function stepFor(phase: string, hasApproval: boolean): number {
  if (phase === "idle" || phase === "proposed") return 1;
  if (phase === "done") return 4;
  if (phase === "gated") return 3;
  return hasApproval ? 3 : 2;
}

export function StewardDemo({ initialScenarioId = SCENARIOS[0].id, compact = false }: { initialScenarioId?: string; compact?: boolean }) {
  const { state, dispatch, skipAhead } = useDemoPlayer(initialScenarioId);
  const scenario = state.scenarioId ? findScenario(state.scenarioId) : undefined;
  const board = boardView(state);
  const lines = terminalView(state);
  const actions = availableActions(state);
  const step = stepFor(state.phase, !!board.approval);

  return (
    <div className={`mkt-demo${compact ? " is-compact" : ""}`}>
      <div className="mkt-demo__top">
        <div className="mkt-demo__label" role="note">
          <span className="mkt-demo__badge">Simulated walkthrough</span>
          <span>Scripted data and a fictional company. No live agents, and nothing is created on any instance.</span>
        </div>
        <ol className="mkt-demo__steps" aria-label="Walkthrough steps">
          {STEPS.map((s) => (
            <li key={s.n} className={s.n === step ? "is-current" : s.n < step ? "is-done" : ""} aria-current={s.n === step ? "step" : undefined}>
              <span className="mkt-demo__step-n">{s.n}</span>
              <span className="mkt-demo__step-label">{s.label}</span>
              <span className="mkt-demo__step-hint">{s.hint}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="mkt-demo__picker" role="group" aria-label="Pick a request">
        <span className="mkt-demo__picker-label">Ask your Chief of Staff to</span>
        <div className="mkt-demo__chips">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`mkt-demo__chip${state.scenarioId === s.id ? " is-active" : ""}`}
              aria-pressed={state.scenarioId === s.id}
              onClick={() => dispatch({ type: "pick", scenarioId: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mkt-demo__panes">
        <TerminalPane
          harness={state.harness}
          lines={lines}
          onHarness={(h) => dispatch({ type: "harness", harness: h })}
        >
          {actions.includes("send") && scenario ? (
            <button type="button" className="mkt-btn mkt-btn--primary" onClick={() => dispatch({ type: "send" })}>
              Send: “{scenario.request}”
            </button>
          ) : null}
          {actions.includes("confirm") ? (
            <button type="button" className="mkt-btn mkt-btn--primary" onClick={() => dispatch({ type: "confirm" })}>
              Reply “yes” to confirm
            </button>
          ) : null}
          {actions.includes("decide") && board.approval ? (
            <>
              <button type="button" className="mkt-btn mkt-btn--primary" onClick={() => dispatch({ type: "decide", decision: "approve" })}>
                Reply “approve”
              </button>
              <button type="button" className="mkt-btn mkt-btn--ghost" onClick={() => dispatch({ type: "decide", decision: "reject" })}>
                Reply “reject”
              </button>
            </>
          ) : null}
          {state.phase === "running" ? (
            <button type="button" className="mkt-btn mkt-btn--ghost" onClick={skipAhead}>
              <FastForward size={16} aria-hidden /> Skip ahead
            </button>
          ) : null}
          {state.phase === "done" ? (
            <button type="button" className="mkt-btn mkt-btn--ghost" onClick={() => dispatch({ type: "reset" })}>
              <RotateCcw size={16} aria-hidden /> Start over
            </button>
          ) : null}
        </TerminalPane>
        <BoardPane
          view={board}
          phase={state.phase}
          onDecide={actions.includes("decide") ? (d) => dispatch({ type: "decide", decision: d }) : undefined}
        />
      </div>
    </div>
  );
}
