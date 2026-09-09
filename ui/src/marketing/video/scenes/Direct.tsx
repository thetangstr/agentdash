import { Caption, PromptLine, Stage, TermLine, TerminalFrame } from "../parts";
import { V } from "../theme";

export function DirectScene() {
  return (
    <Stage>
      <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "0.8fr 1.3fr", gap: 48, padding: "72px 72px 64px", alignItems: "center" }}>
        <div style={{ display: "grid", gap: 18 }}>
          <Caption eyebrow="02 · Direct" title="Steer it from Claude Code or Codex." start={4} />
          <div style={{ color: V.inkSoft, fontSize: 20, lineHeight: 1.5, maxWidth: "26ch" }}>
            The AgentDash MCP server reads your instruction back before anything changes.
          </div>
        </div>
        <TerminalFrame title="claude · agentdash mcp" style={{ minHeight: 440 }}>
          <PromptLine text="Have Quill prepare Monday's board update." start={14} />
          <TermLine glyph="⚙" color={V.termDim} start={68}>
            <span style={{ color: V.termTeal }}>inbox_propose</span> {"{ instruction: \"Have Quill prepare Monday's board update.\" }"}
          </TermLine>
          <TermLine glyph="←" color="#bfb7a8" start={92}>
            Assign to Quill (Chief of Staff): prepare Monday's board update, pulling status from Delivery, Platform and People plus the spend summary from the research pod. Quill drafts; you send. Confirm?
          </TermLine>
          <TermLine glyph="●" color={V.termFg} start={140}>
            <span style={{ fontFamily: V.sans }}>Here's what that would do. Nothing has changed yet. Say yes to confirm.</span>
          </TermLine>
          <PromptLine text="yes" start={186} />
          <TermLine glyph="⚙" color={V.termDim} start={206}>
            <span style={{ color: V.termTeal }}>inbox_confirm</span> {"{ token: \"prop_7f3a\" }"}
          </TermLine>
          <TermLine glyph="←" color="#9fd9b6" start={226}>
            confirmed · assigned to Quill · handle spent
          </TermLine>
        </TerminalFrame>
      </div>
    </Stage>
  );
}
