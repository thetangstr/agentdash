import { useEffect, useRef } from "react";
import { Bot, Check, CircleDashed, Clock3, Loader2, OctagonAlert, User, Workflow, X } from "lucide-react";
import { labelStatus, type BoardView, type IssueView } from "./engine";
import { ACTORS, COMPANY, type Decision } from "./scenarios";

export function BoardPane({
  view,
  phase,
  onDecide,
}: {
  view: BoardView;
  phase: string;
  onDecide?: (d: Decision) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const signature = `${view.issues.length}:${view.activity.length}:${view.deliverable ? 1 : 0}:${phase}`;
  // Follow the work as it arrives, but when something needs the visitor
  // (the approval) or rewards them (the deliverable), bring that into view
  // instead of the bottom of the log.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const focus = el.querySelector<HTMLElement>(
      phase === "gated" ? ".mkt-approval" : view.deliverable ? ".mkt-deliverable" : ".mkt-nothing",
    );
    const top = focus ? Math.max(0, focus.offsetTop - el.offsetTop - 12) : el.scrollHeight;
    if (typeof el.scrollTo === "function") el.scrollTo({ top, behavior: "smooth" });
    else el.scrollTop = top;
  }, [signature, phase, view.deliverable]);

  const roots = view.issues.filter((i) => !i.parent);
  const childrenOf = (id: string) => view.issues.filter((i) => i.parent === id);

  return (
    <section className="mkt-board" aria-label="AgentDash board, simulated">
      <header className="mkt-board__bar">
        <span className="mkt-board__brand">AgentDash</span>
        <span className="mkt-board__company">{COMPANY.name}</span>
        <span className="mkt-board__pulse">
          {phase === "running" ? <Loader2 size={14} className="mkt-spin" aria-hidden /> : null}
          {phase === "running" ? "agents working" : phase === "gated" ? "waiting on you" : phase === "done" ? "finished" : "idle"}
        </span>
      </header>
      <div className="mkt-board__body" ref={scroller}>
        {view.issues.length === 0 ? (
          <div className="mkt-board__empty">
            <Workflow size={20} strokeWidth={1.5} aria-hidden />
            <p>Nothing yet. Once you confirm, Quill turns your request into issues and hands them out.</p>
          </div>
        ) : null}

        {roots.map((root) => (
          <div key={root.id} className="mkt-issue-tree">
            <IssueCard issue={root} />
            {childrenOf(root.id).map((child) => (
              <IssueCard key={child.id} issue={child} nested />
            ))}
          </div>
        ))}

        {view.approval ? (
          <div className={`mkt-approval${view.approval.decision ? ` is-${view.approval.decision}` : ""}`} role="group" aria-label="Approval">
            <div className="mkt-approval__head">
              <OctagonAlert size={16} aria-hidden />
              <span>Approval {view.approval.approvalId}</span>
              <span className="mkt-approval__risk">{view.approval.risk}</span>
            </div>
            <div className="mkt-approval__title">{view.approval.title}</div>
            <p className="mkt-approval__body">{view.approval.body}</p>
            <div className="mkt-approval__meta">
              Requested by {ACTORS[view.approval.requester]?.name} on {view.approval.issueId} · decided by the steward: You
            </div>
            {view.approval.decision ? (
              <div className="mkt-approval__decided">
                {view.approval.decision === "approve" ? <Check size={14} aria-hidden /> : <X size={14} aria-hidden />}
                {view.approval.decision === "approve" ? "Approved by you" : "Rejected by you"} · revision 1
              </div>
            ) : onDecide ? (
              <div className="mkt-approval__actions">
                <button type="button" className="mkt-btn mkt-btn--primary" onClick={() => onDecide("approve")}>
                  {view.approval.approveLabel}
                </button>
                <button type="button" className="mkt-btn mkt-btn--ghost" onClick={() => onDecide("reject")}>
                  {view.approval.rejectLabel}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {view.deliverable ? (
          <div className="mkt-deliverable">
            <div className="mkt-deliverable__eyebrow">Delivered</div>
            <div className="mkt-deliverable__title">{view.deliverable.title}</div>
            <ul className="mkt-deliverable__lines">
              {view.deliverable.lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
            <div className="mkt-deliverable__by">
              {view.deliverable.contributors.map((id) => (
                <span key={id} className="mkt-chip">
                  <ActorGlyph id={id} /> {ACTORS[id]?.name}
                  <span className="mkt-chip__sub">{ACTORS[id]?.kind === "autonomous" ? "routine" : ACTORS[id]?.steward === "You" ? "steward: you" : ACTORS[id]?.steward?.split(" · ")[0]}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {view.activity.length > 0 ? (
          <div className="mkt-activity">
            <div className="mkt-activity__head">Activity log</div>
            <ol>
              {view.activity.map((a, i) => (
                <li key={i}>
                  <span className="mkt-activity__actor">{ACTORS[a.actor]?.name ?? a.actor}</span>
                  <span>{a.text}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function IssueCard({ issue, nested }: { issue: IssueView; nested?: boolean }) {
  const assignee = ACTORS[issue.assignee];
  return (
    <article className={`mkt-issue${nested ? " is-nested" : ""} is-${issue.status}`}>
      <div className="mkt-issue__head">
        <StatusGlyph status={issue.status} />
        <span className="mkt-issue__id">{issue.id}</span>
        <span className="mkt-issue__title">{issue.title}</span>
        <span className="mkt-issue__assignee">
          <ActorGlyph id={issue.assignee} /> {assignee?.name}
        </span>
      </div>
      {issue.comments.length > 0 ? (
        <ul className="mkt-issue__comments">
          {issue.comments.map((c, i) => (
            <li key={i} className={`mkt-comment${c.viaRoutine ? " is-routine" : ""}`}>
              <span className="mkt-comment__who">
                <ActorGlyph id={c.actor} /> {ACTORS[c.actor]?.name}
                <span className="mkt-comment__role">{c.viaRoutine ? "routine" : ACTORS[c.actor]?.role}</span>
              </span>
              <span className="mkt-comment__text">{renderMentions(c.text)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function renderMentions(text: string) {
  const parts = text.split(/(@[A-Z][a-z]+)/g);
  return parts.map((p, i) => (p.startsWith("@") ? <span key={i} className="mkt-mention">{p}</span> : <span key={i}>{p}</span>));
}

function StatusGlyph({ status }: { status: IssueView["status"] }) {
  const label = labelStatus(status);
  switch (status) {
    case "todo": return <CircleDashed size={14} aria-label={label} />;
    case "in_progress": return <Clock3 size={14} aria-label={label} />;
    case "blocked": return <OctagonAlert size={14} aria-label={label} />;
    case "done": return <Check size={14} aria-label={label} />;
  }
}

function ActorGlyph({ id }: { id: string }) {
  const a = ACTORS[id];
  if (!a) return null;
  if (a.kind === "human") return <User size={12} aria-hidden />;
  return <Bot size={12} aria-hidden />;
}
