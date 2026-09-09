import { useCurrentFrame } from "remotion";
import { Caption, Panel, PromptLine, Rise, Stage, Tag, TermLine, TerminalFrame } from "../parts";
import { V } from "../theme";

export function DecideScene() {
  const frame = useCurrentFrame();
  const decided = frame >= 150;
  return (
    <Stage background={V.cream2}>
      <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateRows: "auto 1fr", gap: 28, padding: "56px 64px 56px" }}>
        <Caption eyebrow="04 · Decide" title="Anything risky waits for you. One handle, one decision, one revision." start={4} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, alignItems: "start" }}>
          <Rise start={16}>
            <Panel style={{ padding: 20, borderColor: decided ? V.success : V.accent, background: decided ? "#f6faf7" : "#fff8f5" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: V.mono, fontSize: 13, color: decided ? V.success : V.accentInk }}>
                <span>Approval A-108</span>
                <span style={{ marginLeft: "auto" }}><Tag tone={decided ? "success" : "accent"}>{decided ? "Approved by you" : "External contact"}</Tag></span>
              </div>
              <div style={{ fontFamily: V.serif, fontSize: 26, lineHeight: 1.2, marginTop: 10 }}>
                Send a status request to the Atlas client PM?
              </div>
              <p style={{ margin: "10px 0 0", fontSize: 15, color: V.inkSoft, lineHeight: 1.5 }}>
                Marlow drafted a three-line email. Policy: agents draft, a human sends. Approving places the draft in your outbox; rejecting reports the gap as-is.
              </p>
              <div style={{ marginTop: 12, fontSize: 13, color: V.inkFaint }}>Requested by Marlow on HAL-42 · decided by the steward: You</div>
            </Panel>
          </Rise>
          <TerminalFrame title="claude · agentdash mcp" style={{ minHeight: 300 }}>
            <TermLine glyph="⚙" color={V.termDim} start={40}>
              <span style={{ color: V.termTeal }}>inbox_sync</span>
            </TermLine>
            <TermLine glyph="←" color={V.termAccent} start={56}>
              1 needs a decision · 3 in progress · 0 stopped
            </TermLine>
            <TermLine glyph="●" color={V.termFg} start={72}>
              <span style={{ fontFamily: V.sans }}>Marlow is asking: send a status request to the Atlas client PM? (External contact.) Approve or reject?</span>
            </TermLine>
            <PromptLine text="approve" start={118} />
            <TermLine glyph="⚙" color={V.termDim} start={138}>
              <span style={{ color: V.termTeal }}>inbox_decide</span> {"{ handle: \"dec_21c9\", decision: \"approved\" }"}
            </TermLine>
            <TermLine glyph="←" color="#9fd9b6" start={152}>
              A-108 approved · draft placed in your outbox
            </TermLine>
          </TerminalFrame>
        </div>
      </div>
    </Stage>
  );
}
