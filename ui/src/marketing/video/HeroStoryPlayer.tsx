import { Player } from "@remotion/player";
import { HeroStory } from "./HeroStory";
import { TOTAL_FRAMES, V } from "./theme";

/**
 * The in-page player. Loaded lazily by sections/HeroPlayer so the landing
 * page's first paint does not wait for Remotion.
 */
export default function HeroStoryPlayer({ autoPlay }: { autoPlay: boolean }) {
  return (
    <Player
      component={HeroStory}
      durationInFrames={TOTAL_FRAMES}
      fps={V.fps}
      compositionWidth={V.width}
      compositionHeight={V.height}
      style={{ width: "100%", aspectRatio: `${V.width} / ${V.height}` }}
      autoPlay={autoPlay}
      loop
      controls
      clickToPlay
      showVolumeControls={false}
      spaceKeyToPlayOrPause={false}
      initiallyMuted
      // No audio in the story: without shared audio tags the browser's
      // autoplay policy has nothing to block.
      numberOfSharedAudioTags={0}
      acknowledgeRemotionLicense
    />
  );
}
