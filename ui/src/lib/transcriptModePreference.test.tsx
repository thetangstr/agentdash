// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPT_MODE_STORAGE_KEY,
  readTranscriptModePreference,
  useTranscriptModePreference,
  writeTranscriptModePreference,
} from "./transcriptModePreference";
import { TranscriptModeToggle } from "../components/transcript/ReadableTranscript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ id }: { id: string }) {
  const [mode, setMode] = useTranscriptModePreference();
  return (
    <div data-probe={id} data-mode={mode}>
      <TranscriptModeToggle mode={mode} onChange={setMode} />
    </div>
  );
}

describe("transcript mode preference", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    writeTranscriptModePreference("readable");
    window.localStorage.clear();
  });

  it("defaults to readable", () => {
    expect(readTranscriptModePreference()).toBe("readable");
  });

  it("migrates a stored legacy 'nice' value to readable", () => {
    window.localStorage.setItem(TRANSCRIPT_MODE_STORAGE_KEY, "nice");
    expect(readTranscriptModePreference()).toBe("readable");
  });

  it("persists the toggle under an agentdash.* key and syncs every toggle on the page", () => {
    act(() => {
      root.render(
        <>
          <Probe id="a" />
          <Probe id="b" />
        </>,
      );
    });
    const probes = () => Array.from(container.querySelectorAll<HTMLElement>("[data-probe]")).map((el) => el.dataset.mode);
    expect(probes()).toEqual(["readable", "readable"]);

    const rawButton = container.querySelector<HTMLButtonElement>('[data-probe="a"] [data-transcript-mode="raw"]')!;
    act(() => rawButton.click());

    expect(TRANSCRIPT_MODE_STORAGE_KEY.startsWith("agentdash.")).toBe(true);
    expect(window.localStorage.getItem(TRANSCRIPT_MODE_STORAGE_KEY)).toBe("raw");
    expect(probes()).toEqual(["raw", "raw"]);
    expect(rawButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("still toggles in memory when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeTranscriptModePreference("raw")).not.toThrow();
    expect(readTranscriptModePreference()).toBe("raw");
    writeTranscriptModePreference("readable");
    expect(readTranscriptModePreference()).toBe("readable");
  });
});
