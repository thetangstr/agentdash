import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { Progress, SimulatedBadge } from "./parts";
import { SCENES, V } from "./theme";
import { HireScene } from "./scenes/Hire";
import { DirectScene } from "./scenes/Direct";
import { DelegateScene } from "./scenes/Delegate";
import { DecideScene } from "./scenes/Decide";
import { ResultScene } from "./scenes/Result";

/**
 * Soft cross-fade at scene edges so cuts never feel abrupt. Rendered inside a
 * <Sequence>, so useCurrentFrame() is already relative to the scene start.
 */
function Fade({ duration, first, children }: { duration: number; first?: boolean; children: React.ReactNode }) {
  const local = useCurrentFrame();
  // The opening scene is fully visible at frame 0 so a paused player still
  // shows a complete first frame.
  const o = interpolate(local, [0, 10, duration - 10, duration], [first ? 1 : 0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
}

export function HeroStory() {
  return (
    <AbsoluteFill style={{ background: V.cream }}>
      {(
        [
          ["hire", HireScene],
          ["direct", DirectScene],
          ["delegate", DelegateScene],
          ["decide", DecideScene],
          ["result", ResultScene],
        ] as const
      ).map(([key, Scene]) => {
        const { from, duration } = SCENES[key];
        return (
          <Sequence key={key} from={from} durationInFrames={duration} name={key}>
            <Fade duration={duration} first={from === 0}>
              <Scene />
            </Fade>
          </Sequence>
        );
      })}
      <SimulatedBadge />
      <Progress />
    </AbsoluteFill>
  );
}
