import "./SectionContainer.css";
import type { ReactNode } from "react";

export function SectionContainer({
  children,
  background = "cream",
  id,
  as: Tag = "section",
}: {
  children: ReactNode;
  background?: "cream" | "cream-2";
  id?: string;
  as?: "section" | "div";
}) {
  const cls = ["mkt-section", background === "cream-2" ? "mkt-section--cream-2" : null]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag id={id} className={cls}>
      <div className="mkt-section__inner">{children}</div>
    </Tag>
  );
}
