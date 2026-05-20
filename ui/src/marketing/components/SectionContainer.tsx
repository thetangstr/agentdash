import "./SectionContainer.css";
import type { ReactNode } from "react";

export function SectionContainer({
  children,
  background = "cream",
  spacing = "normal",
  id,
  as: Tag = "section",
}: {
  children: ReactNode;
  background?: "cream" | "cream-2";
  spacing?: "normal" | "compact";
  id?: string;
  as?: "section" | "div";
}) {
  const cls = [
    "mkt-section",
    background === "cream-2" ? "mkt-section--cream-2" : null,
    spacing === "compact" ? "mkt-section--compact" : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag id={id} className={cls}>
      <div className="mkt-section__inner">{children}</div>
    </Tag>
  );
}
