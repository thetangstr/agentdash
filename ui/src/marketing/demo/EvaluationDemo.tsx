import { useRef, useState, type KeyboardEvent } from "react";
import { EVIDENCE_CASES, EVIDENCE_CASE_KEYS, REPORT_SECTIONS, demoMoney, evidenceChecks, type EvidenceCaseKey } from "../content/evaluation-demo";
import "./EvaluationDemo.css";
const stateText = { supported: "Supported", failed: "Failed", unverified: "Unverified", blocked: "Blocked" } as const;

export function EvaluationDemo() {
  const [selected, setSelected] = useState<EvidenceCaseKey>("supported");
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = EVIDENCE_CASES[selected];
  const checks = evidenceChecks(current);
  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? EVIDENCE_CASE_KEYS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + EVIDENCE_CASE_KEYS.length) % EVIDENCE_CASE_KEYS.length;
    setSelected(EVIDENCE_CASE_KEYS[next]!); refs.current[next]?.focus();
  }
  return <div className="mkt-evidence">
    <p className="mkt-evidence__disclosure"><strong>Simulated walkthrough.</strong> Fictional report and receipts. No agent or instance is connected; no real work runs.</p>
    <div className="mkt-evidence__picker" role="group" aria-label="Choose an illustrative task-evidence case">
      {EVIDENCE_CASE_KEYS.map((key, index) => <button key={key} type="button" ref={element => { refs.current[index] = element; }} aria-pressed={selected === key} onClick={() => setSelected(key)} onKeyDown={event => onKey(event, index)}><span aria-hidden>{String(index + 1).padStart(2, "0")}</span>{EVIDENCE_CASES[key].button}</button>)}
    </div>
    <div className="mkt-evidence__claim"><div><span>Agent claim</span><p>“{current.claim}”</p></div><p className={`mkt-evidence__status is-${current.state}`} role="status" aria-live="polite" aria-atomic="true">{current.status}</p></div>
    <div className="mkt-evidence__comparison">
      <section className="mkt-evidence__artifact" aria-label="Illustrative saved report">
        <div className="mkt-evidence__caption"><span>01 · Inspect the artifact</span><span>Revision 3{current.blocked ? " · Draft" : ""}</span></div>
        <div className="mkt-evidence__paper"><div className="mkt-evidence__report-kicker">Client update <span>November</span></div><h3>Quarterly<br />delivery report</h3><p className="mkt-evidence__deck">Illustrative saved document</p>
          <ol>{REPORT_SECTIONS.map((section, index) => <li key={section} className={current.sections.includes(section) ? "" : "is-missing"}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{section}</strong><p>{current.sections.includes(section) ? ["Completed deliverables and delivery position.", "Reported expenditure and source references.", "Open risks, owners and proposed next steps."][index] : current.blocked ? "Not yet completed · access approval pending" : "Required section absent from saved content"}</p></div></li>)}</ol>
          <div className="mkt-evidence__total"><span>Reported total</span><strong>{demoMoney(current.total)}</strong></div><div className="mkt-evidence__paper-footer"><span>{current.sources} source references</span><span>Fictional artifact</span></div>
        </div><p className="mkt-evidence__note">{current.note}</p>
      </section>
      <section className="mkt-evidence__checks" aria-label="Criteria and underlying receipts"><div className="mkt-evidence__caption"><span>02 · Compare the evidence</span><span>Rubric v1</span></div><h3>The agreement, checked.</h3>
        <ol>{checks.map(check => <li key={check.key} className={`mkt-evidence__check is-${check.state}`} data-check={check.key}><span aria-hidden>{check.state === "supported" ? "✓" : check.state === "failed" ? "×" : check.state === "unverified" ? "?" : "–"}</span><div><h4>{check.title}</h4><p>{check.detail}</p></div><strong>{stateText[check.state]}</strong></li>)}</ol>
        <div className="mkt-evidence__receipts"><h4>Underlying receipts</h4><ul>{current.observations.map(observation => <li key={observation}>{observation}</li>)}</ul></div>
        <p className={`mkt-evidence__explanation is-${current.state}`}>{current.explanation}</p>
      </section>
    </div>
    <dl className="mkt-evidence__outcomes"><div><dt>Task acceptance</dt><dd>{current.blocked ? "Not complete · approval pending" : "Owner decision not recorded"}</dd></div><div><dt>Project progress</dt><dd>{selected === "supported" ? "Deliverable evidence available" : current.blocked ? "Waiting on a decision" : "Work or evidence still needed"}</dd></div><div><dt>Business outcome</dt><dd>Not measured by this check</dd></div></dl>
    <p className="mkt-evidence__separation">Task evidence is one input. It does not certify the agent or prove a business result.</p>
  </div>;
}
