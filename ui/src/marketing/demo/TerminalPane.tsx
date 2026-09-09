import { useEffect, useRef } from "react";
import type { Harness, TerminalLine } from "./engine";

const HARNESS_LABEL: Record<Harness, { title: string; prompt: string; hint: string }> = {
  claude: { title: "Claude Code", prompt: ">", hint: "claude · agentdash mcp" },
  codex: { title: "Codex", prompt: "›", hint: "codex · agentdash mcp" },
};

export function TerminalPane({
  harness,
  lines,
  onHarness,
  children,
}: {
  harness: Harness;
  lines: TerminalLine[];
  onHarness: (h: Harness) => void;
  children?: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const meta = HARNESS_LABEL[harness];
  return (
    <section className="mkt-term" aria-label={`${meta.title} terminal, simulated`}>
      <header className="mkt-term__bar">
        <span className="mkt-term__dots" aria-hidden><i /><i /><i /></span>
        <span className="mkt-term__title">{meta.hint}</span>
        <div className="mkt-term__switch" role="group" aria-label="Choose your harness">
          {(["claude", "codex"] as Harness[]).map((h) => (
            <button
              key={h}
              type="button"
              className={`mkt-term__switch-btn${h === harness ? " is-active" : ""}`}
              aria-pressed={h === harness}
              onClick={() => onHarness(h)}
            >
              {HARNESS_LABEL[h].title}
            </button>
          ))}
        </div>
      </header>
      <div className="mkt-term__body" ref={scroller} aria-live="polite">
        {lines.length === 0 ? (
          <p className="mkt-term__empty">
            Pick a request above. You'll direct your Chief of Staff from here, the way
            you already talk to {meta.title}.
          </p>
        ) : null}
        {lines.map((l, i) => (
          <TerminalRow key={i} line={l} prompt={meta.prompt} />
        ))}
      </div>
      {children ? <div className="mkt-term__actions">{children}</div> : null}
    </section>
  );
}

function TerminalRow({ line, prompt }: { line: TerminalLine; prompt: string }) {
  switch (line.kind) {
    case "prompt":
      return (
        <div className="mkt-term__line mkt-term__line--prompt">
          <span className="mkt-term__glyph" aria-hidden>{prompt}</span>
          <span>{line.text}</span>
        </div>
      );
    case "tool":
      return (
        <div className="mkt-term__line mkt-term__line--tool">
          <span className="mkt-term__glyph" aria-hidden>⚙</span>
          <span>
            <span className="mkt-term__tool">{line.name}</span>
            {line.args ? <span className="mkt-term__args"> {line.args}</span> : null}
          </span>
        </div>
      );
    case "out":
      return (
        <div className={`mkt-term__line mkt-term__line--out is-${line.tone ?? "dim"}`}>
          <span className="mkt-term__glyph" aria-hidden>←</span>
          <span>{line.text}</span>
        </div>
      );
    case "assistant":
      return (
        <div className="mkt-term__line mkt-term__line--assistant">
          <span className="mkt-term__glyph" aria-hidden>●</span>
          <span>{line.text}</span>
        </div>
      );
  }
}
