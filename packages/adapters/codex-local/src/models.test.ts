import { describe, expect, it } from "vitest";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
  isCodexLocalManualModel,
  models,
} from "./index.js";

// The bug this file exists to stop is not "the list is stale" -- it is that
// FIXING the staleness broke something else, quietly, in the same commit.
//
// `isCodexLocalFastModeSupported` grants fast mode to any model it does not
// recognise, on the reasoning that a hand-typed model is the operator's
// business. So a model that is missing from `models` has fast mode, and the
// moment someone adds it to the picker it loses fast mode unless they also
// remember this second list. Adding the gpt-5.6 family did exactly that.
//
// The test pins the COUPLING rather than the membership, so it keeps working
// at the next model release instead of just recording today's answer.
describe("codex-local fast mode and the model picker", () => {
  it("does not let a model lose fast mode by becoming selectable", () => {
    // Every entry that is now a known model must be named in the fast-mode
    // list, or it was better off unlisted -- which is the regression.
    const regressed = CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.filter(
      (id) => !models.some((entry) => entry.id === id),
    );
    expect(
      regressed,
      "fast-mode models that are not in the picker: harmless, but they are relying on the manual-model fallback",
    ).toEqual([]);
  });

  it("keeps fast mode for the gpt-5.6 family now that it is listed", () => {
    const family = models.filter((entry) => entry.id.startsWith("gpt-5.6"));
    expect(family.length, "gpt-5.6 family missing from the picker").toBeGreaterThan(0);

    for (const entry of family) {
      // Not manual any more -- so the manual-model fallback no longer covers it.
      expect(isCodexLocalManualModel(entry.id), `${entry.id} should be a known model`).toBe(false);
      expect(
        isCodexLocalFastModeSupported(entry.id),
        `${entry.id} is selectable but cannot use fast mode — add it to CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS`,
      ).toBe(true);
    }
  });

  it("still grants fast mode to a model typed in by hand", () => {
    // The escape hatch that made the regression invisible. Keep it working.
    expect(isCodexLocalManualModel("gpt-6-not-released-yet")).toBe(true);
    expect(isCodexLocalFastModeSupported("gpt-6-not-released-yet")).toBe(true);
  });

  it("offers no duplicate ids", () => {
    const ids = models.map((entry) => entry.id);
    expect(new Set(ids).size, `duplicate model ids: ${ids.join(", ")}`).toBe(ids.length);
  });
});
