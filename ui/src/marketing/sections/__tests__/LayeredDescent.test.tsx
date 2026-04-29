import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { LayeredDescent } from "../LayeredDescent";

describe("LayeredDescent (reduced motion)", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders all 7 layer names in the DOM", () => {
    render(<LayeredDescent />);
    const names = [
      "Control Plane",
      "Orchestration",
      "Workspaces & Adapters",
      "Agent Primitives",
      "Interop",
      "Trust & Safety",
      "Model Serving",
    ];
    names.forEach((n) => {
      expect(screen.getByRole("heading", { name: n })).toBeInTheDocument();
    });
  });

  it("uses the reduced-motion class on the wrapper", () => {
    const { container } = render(<LayeredDescent />);
    expect(container.querySelector(".mkt-descent--reduced")).toBeInTheDocument();
  });
});
