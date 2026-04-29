import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarketingShell } from "../MarketingShell";

describe("MarketingShell", () => {
  it("renders header, main, and footer", () => {
    render(
      <MarketingShell><h1>Hello</h1></MarketingShell>,
    );
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("includes a skip-to-content link as the first focusable element", () => {
    render(
      <MarketingShell><div /></MarketingShell>,
    );
    expect(screen.getByText("Skip to content")).toBeInTheDocument();
  });
});
