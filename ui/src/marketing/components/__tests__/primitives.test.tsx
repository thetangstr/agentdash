import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Eyebrow } from "../Eyebrow";
import { SectionContainer } from "../SectionContainer";
import { QuoteBlock } from "../QuoteBlock";
import { LogoStrip } from "../LogoStrip";

describe("Eyebrow", () => {
  it("renders its children with the eyebrow class", () => {
    render(<Eyebrow>READY</Eyebrow>);
    const el = screen.getByText("READY");
    expect(el).toHaveClass("mkt-eyebrow");
  });
});

describe("SectionContainer", () => {
  it("renders as <section> by default with cream background class", () => {
    const { container } = render(<SectionContainer><p>hi</p></SectionContainer>);
    const section = container.querySelector("section");
    expect(section).toBeInTheDocument();
    expect(section).toHaveClass("mkt-section");
    expect(section).not.toHaveClass("mkt-section--cream-2");
  });

  it("applies cream-2 class when requested", () => {
    const { container } = render(
      <SectionContainer background="cream-2"><p>hi</p></SectionContainer>,
    );
    expect(container.querySelector("section")).toHaveClass("mkt-section--cream-2");
  });
});

describe("QuoteBlock", () => {
  it("renders quote and attribution", () => {
    render(<QuoteBlock quote="Ship it" attribution="A. Person" />);
    expect(screen.getByText(/Ship it/)).toBeInTheDocument();
    expect(screen.getByText("A. Person")).toBeInTheDocument();
  });
});

describe("LogoStrip", () => {
  it("renders one item per logo, image when src is provided", () => {
    render(<LogoStrip items={[{ name: "ACME", src: "/x.svg" }, { name: "Beta" }]} />);
    expect(screen.getByAltText("ACME")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
  });
});
