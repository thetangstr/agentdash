// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TierBadge } from "./TierBadge";

describe("TierBadge", () => {
  it("renders the display label for each tier", () => {
    expect(renderToStaticMarkup(<TierBadge tier="free" />)).toContain(">Free<");
    expect(renderToStaticMarkup(<TierBadge tier="pro" />)).toContain(">Pro<");
    expect(renderToStaticMarkup(<TierBadge tier="enterprise" />)).toContain(
      ">Enterprise<",
    );
  });

  it("encodes the tier in a data attribute so screens can assert state", () => {
    const html = renderToStaticMarkup(<TierBadge tier="pro" />);
    expect(html).toContain(`data-tier="pro"`);
    expect(html).toContain(`data-testid="tier-badge"`);
  });

  it("accepts a custom className without dropping base styling", () => {
    const html = renderToStaticMarkup(
      <TierBadge tier="free" className="ml-2" />,
    );
    expect(html).toContain("ml-2");
    expect(html).toContain("rounded-full");
  });
});
