// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_DESTRUCTIVE_ACTION_CLASSES } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultDestructiveActionsNotice } from "./DefaultDestructiveActionsNotice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// T5a-3 — onboarding display of the default destructive-action class list.
// See doc/plans/2026-08-04-t5-destructive-classifier.md.
//
// The MK owner is shown, at company governance setup, the default classes the
// `destructiveActions` ceiling applies to — the exact same code constant the
// server-side classifier enforces (T5a-1), so the list and the enforcement can
// never drift. Read-only in T5a; the owner-ADD capability is T5b (needs a
// migration).
//
// Asserted against textContent (jsdom) rather than raw markup so an apostrophe
// entity-escaped by React (`human's` → `&#x27;`) still matches the constant.

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

function render() {
  act(() => {
    createRoot(container).render(<DefaultDestructiveActionsNotice />);
  });
  return container.textContent ?? "";
}

describe("DefaultDestructiveActionsNotice", () => {
  it("frames the list as approval-by-default", () => {
    expect(render()).toContain("require your approval by default");
  });

  it("renders all nine default destructive-action classes with their rationales", () => {
    const text = render();

    // Guard the count so a shrunk constant can't silently pass.
    expect(DEFAULT_DESTRUCTIVE_ACTION_CLASSES).toHaveLength(9);

    for (const entry of DEFAULT_DESTRUCTIVE_ACTION_CLASSES) {
      expect(text).toContain(entry.label);
      expect(text).toContain(entry.rationale);
    }
  });
});
