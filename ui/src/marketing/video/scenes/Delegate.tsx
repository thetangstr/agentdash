import { useCurrentFrame } from "remotion";
import { Caption, Panel, Rise, Stage, Tag } from "../parts";
import { V } from "../theme";

const ISSUES = [
  { id: "HAL-41", title: "Board update · Monday", who: "Quill", at: 12, nested: false },
  { id: "HAL-42", title: "Client project status + commitments at risk", who: "Marlow", at: 60, nested: true },
  { id: "HAL-43", title: "Platform incidents + repo health", who: "Ada", at: 72, nested: true },
  { id: "HAL-44", title: "Roles blocking delivery + candidates waiting", who: "Reyes", at: 84, nested: true },
];

const COMMENTS = [
  { who: "Quill", role: "Chief of Staff", at: 34, text: "Splitting this into four inputs. @Marlow @Ada @Reyes, one section each, sources attached. @Tally's Monday spend routine covers the numbers.", tone: "plain" as const },
  { who: "Ada", role: "Platform agent", at: 130, text: "3 incidents in 30 days, all under 2h. Two repos without CI. Source: incident log.", tone: "plain" as const },
  { who: "Tally", role: "routine", at: 176, text: "Weekly spend: 2.1M tokens, $61.40, 68% on delivery work. Source: cost ledger.", tone: "routine" as const },
  { who: "Reyes", role: "People agent", at: 218, text: "Two roles block delivery. 4 candidates have waited on us for more than 7 days. Source: ATS export.", tone: "plain" as const },
  { who: "Marlow", role: "Delivery agent", at: 264, text: "5 of 6 projects sourced from the boards. Atlas has no update since the 22nd. I can ask their PM, but I can't contact a client directly.", tone: "blocked" as const },
];

function Mention({ text }: { text: string }) {
  const parts = text.split(/(@[A-Z][a-z]+)/g);
  return <>{parts.map((p, i) => (p.startsWith("@") ? <b key={i} style={{ color: V.accentInk }}>{p}</b> : <span key={i}>{p}</span>))}</>;
}

export function DelegateScene() {
  const frame = useCurrentFrame();
  return (
    <Stage>
      <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "0.8fr 1.4fr", gap: 40, padding: "64px 64px 56px", alignItems: "start" }}>
        <div style={{ display: "grid", gap: 18, paddingTop: 24 }}>
          <Caption eyebrow="03 · Delegate" title="It works with the rest of your workforce." start={4} />
          <div style={{ color: V.inkSoft, fontSize: 20, lineHeight: 1.5, maxWidth: "26ch" }}>
            Issues, @-mentions and routines. Stewarded agents and autonomous teams in one company, one activity log.
          </div>
        </div>
        <Panel style={{ padding: 0, height: 600 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: `1px solid ${V.rule}`, background: V.cream, fontSize: 14 }}>
            <b>AgentDash</b>
            <span style={{ color: V.inkSoft, flex: 1 }}>Halden &amp; Co.</span>
            <span style={{ fontFamily: V.mono, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: V.inkSoft }}>
              {frame > 40 ? "agents working" : "assigned"}
            </span>
          </div>
          <div style={{ padding: 12, display: "grid", gap: 6 }}>
            {ISSUES.map((it) => (
              <Rise key={it.id} start={it.at} len={14}>
                <div style={{ marginLeft: it.nested ? 22 : 0, border: `1px solid ${V.rule}`, borderRadius: 10, padding: "8px 12px", display: "grid", gap: 6 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 10, alignItems: "center", fontSize: 16 }}>
                    <span style={{ fontFamily: V.mono, fontSize: 13, color: V.inkFaint }}>{it.id}</span>
                    <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</b>
                    <span style={{ fontSize: 13, color: V.inkSoft, border: `1px solid ${V.rule}`, borderRadius: 999, padding: "2px 8px" }}>{it.who}</span>
                  </div>
                  {COMMENTS.filter((c) => (it.id === "HAL-41" ? ["Quill", "Tally"].includes(c.who) : it.id === "HAL-43" ? c.who === "Ada" : it.id === "HAL-44" ? c.who === "Reyes" : c.who === "Marlow")).map((c) => (
                    <Rise key={c.who + c.at} start={c.at} len={14}>
                      <div style={{ background: c.tone === "routine" ? V.tealTint : c.tone === "blocked" ? "#fff5ee" : V.cream, borderRadius: 8, padding: "6px 10px", fontSize: 14, display: "grid", gap: 2 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                          <b>{c.who}</b>
                          <span style={{ color: V.inkFaint }}>{c.role}</span>
                          {c.tone === "blocked" ? <Tag>Needs a decision</Tag> : null}
                        </div>
                        <div style={{ lineHeight: 1.45 }}><Mention text={c.text} /></div>
                      </div>
                    </Rise>
                  ))}
                </div>
              </Rise>
            ))}
          </div>
        </Panel>
      </div>
    </Stage>
  );
}
