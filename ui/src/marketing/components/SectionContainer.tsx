import "./SectionContainer.css";
import type { ReactNode } from "react";

export function SectionContainer({
  children,
  background = "cream",
  padding = "default",
  id,
  as: Tag = "section",
}: {
  children: ReactNode;
  background?: "cream" | "cream-2";
  /** "hero" trims the top so the first screen is not mostly air. */
  padding?: "default" | "hero";
  id?: string;
  as?: "section" | "div";
}) {
  const cls = [
    "mkt-section",
    background === "cream-2" ? "mkt-section--cream-2" : null,
    padding === "hero" ? "mkt-section--hero" : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag id={id} className={cls}>
      <div className="mkt-section__inner">{children}</div>
    </Tag>
  );
}
