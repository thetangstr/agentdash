import { useEffect, useRef, useState } from "react";

export function computeProgress(
  rect: { top: number; height: number },
  viewportHeight: number,
): number {
  const travel = rect.height - viewportHeight;
  if (travel <= 0) return 0;
  // top is 0 when section enters viewport from above; goes negative as we scroll past.
  // Progress = how far through `travel` we've scrolled, clamped 0..1.
  const scrolled = -rect.top;
  if (scrolled <= 0) return 0;
  if (scrolled >= travel) return 1;
  return scrolled / travel;
}

export function useDescentProgress(ref: React.RefObject<HTMLElement | null>): number {
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      const el = ref.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const next = computeProgress(
          { top: rect.top, height: rect.height },
          window.innerHeight,
        );
        setProgress((prev) => (Math.abs(prev - next) < 0.001 ? prev : next));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [ref]);

  return progress;
}
