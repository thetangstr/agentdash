import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePrefersReducedMotion } from "../usePrefersReducedMotion";

type Listener = (event: { matches: boolean }) => void;

describe("usePrefersReducedMotion", () => {
  let listeners: Listener[] = [];
  let currentMatches = false;

  beforeEach(() => {
    listeners = [];
    currentMatches = false;
    vi.stubGlobal("matchMedia", (q: string) => ({
      media: q,
      get matches() { return currentMatches; },
      addEventListener: (_: string, l: Listener) => listeners.push(l),
      removeEventListener: (_: string, l: Listener) => {
        listeners = listeners.filter((x) => x !== l);
      },
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns false when the user has no reduced-motion preference", () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it("returns true when the media query matches", () => {
    currentMatches = true;
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it("flips when the media query change event fires", () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => {
      currentMatches = true;
      listeners.forEach((l) => l({ matches: true }));
    });
    expect(result.current).toBe(true);
  });
});
