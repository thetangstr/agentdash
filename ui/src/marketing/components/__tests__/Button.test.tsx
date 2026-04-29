import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "../Button";

describe("Button", () => {
  it("renders as <a> when given href", () => {
    render(<Button href="/foo">Hello</Button>);
    const el = screen.getByRole("link", { name: "Hello" });
    expect(el).toBeInTheDocument();
    expect(el.getAttribute("href")).toBe("/foo");
  });

  it("renders as <button> when no href", () => {
    render(<Button onClick={() => {}}>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("applies primary variant by default", () => {
    render(<Button href="/x">x</Button>);
    expect(screen.getByRole("link")).toHaveClass("mkt-btn--primary");
  });

  it("applies ghost variant when specified", () => {
    render(<Button href="/x" variant="ghost">x</Button>);
    expect(screen.getByRole("link")).toHaveClass("mkt-btn--ghost");
  });
});
