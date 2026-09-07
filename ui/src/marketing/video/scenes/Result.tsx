import { Caption, Panel, Rise, Stage, Tag } from "../parts";
import { V } from "../theme";

const LINES = [
  "Delivery: 5 of 6 projects on track. Atlas awaiting the email in your outbox.",
  "Platform: 3 incidents, all under 2h. Two repos without CI flagged.",
  "People: 2 roles blocking delivery, 4 candidates waiting on us.",
  "Spend: 2.1M tokens, $61.40 this week, 68% on delivery.",
];

const BY = [
  ["Quill", "steward: you"],
  ["Marlow", "Jonah"],
  ["Ada", "Lena"],
  ["Reyes", "Tomas"],
  ["Tally", "routine"],
];

export function ResultScene() {
  return (
    <Stage>
      <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 48, padding: "72px 72px 64px", alignItems: "center" }}>
        <div style={{ display: "grid", gap: 20 }}>
          <Caption eyebrow="05 · Result" title="Stewarded by you. Run from where you already work." start={4} />
          <Rise start={40}>
            <div style={{ color: V.inkSoft, fontSize: 20, lineHeight: 1.5, maxWidth: "28ch" }}>
              Every section attributed to an agent and its steward. Every number linked to a source. Every action in the log.
            </div>
          </Rise>
        </div>
        <Rise start={12}>
          <Panel style={{ padding: 22, borderLeft: `5px solid ${V.teal}` }}>
            <div style={{ fontFamily: V.mono, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", color: V.teal }}>Delivered</div>
            <div style={{ fontFamily: V.serif, fontSize: 30, marginTop: 6 }}>Board update · Monday</div>
            <ul style={{ margin: "14px 0 0", paddingLeft: 20, display: "grid", gap: 6, fontSize: 15 }}>
              {LINES.map((l, i) => (
                <Rise key={l} start={30 + i * 8} len={12}><li>{l}</li></Rise>
              ))}
            </ul>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
              {BY.map(([n, s], i) => (
                <Rise key={n} start={70 + i * 5} len={10}>
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center", border: `1px solid ${V.rule}`, borderRadius: 999, padding: "4px 10px", fontSize: 13 }}>
                    <b>{n}</b><span style={{ color: V.inkFaint }}>{s}</span>
                  </span>
                </Rise>
              ))}
            </div>
            <Rise start={100}>
              <div style={{ marginTop: 16 }}><Tag tone="ink">Simulated walkthrough · fictional company</Tag></div>
            </Rise>
          </Panel>
        </Rise>
      </div>
    </Stage>
  );
}
