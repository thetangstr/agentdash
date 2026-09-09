import { Caption, Panel, Rise, Stage, Tag } from "../parts";
import { V } from "../theme";

const TEAM = [
  { name: "Marlow", role: "Delivery agent", steward: "Jonah · Delivery lead" },
  { name: "Ada", role: "Platform agent", steward: "Lena · Platform lead" },
  { name: "Reyes", role: "People agent", steward: "Tomas · People lead" },
];

export function HireScene() {
  return (
    <Stage>
      <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "1fr 1.1fr", gap: 48, padding: "72px 72px 64px", alignItems: "center" }}>
        <Caption eyebrow="01 · Hire" title="A Chief of Staff, stewarded by you." start={6} />
        <div style={{ display: "grid", gap: 14 }}>
          <Rise start={18}>
            <Panel style={{ padding: 22, borderColor: V.accent }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontFamily: V.serif, fontSize: 30 }}>Quill</div>
                  <div style={{ color: V.inkSoft, fontSize: 16 }}>Chief of Staff · Halden &amp; Co.</div>
                </div>
                <Tag>Steward: You</Tag>
              </div>
              <div style={{ marginTop: 14, fontSize: 15, color: V.inkSoft, borderTop: `1px solid ${V.rule}`, paddingTop: 12 }}>
                Accountable human: <b style={{ color: V.ink }}>You</b>. Hires, deletions, external contact and budget changes wait for your decision.
              </div>
            </Panel>
          </Rise>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            {TEAM.map((m, i) => (
              <Rise key={m.name} start={54 + i * 10}>
                <Panel style={{ padding: 14 }}>
                  <div style={{ fontFamily: V.serif, fontSize: 21 }}>{m.name}</div>
                  <div style={{ color: V.inkSoft, fontSize: 13 }}>{m.role}</div>
                  <div style={{ marginTop: 8, fontSize: 12, color: V.inkFaint }}>Steward: {m.steward}</div>
                </Panel>
              </Rise>
            ))}
          </div>
          <Rise start={96}>
            <Panel style={{ padding: 14, background: V.tealTint, borderColor: "#bfe3dc" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontFamily: V.serif, fontSize: 21 }}>Research pod · Scout, Tally</div>
                  <div style={{ color: V.inkSoft, fontSize: 13 }}>Autonomous team. Runs on routines, reports into the same company.</div>
                </div>
                <Tag tone="teal">Autonomous</Tag>
              </div>
            </Panel>
          </Rise>
        </div>
      </div>
    </Stage>
  );
}
