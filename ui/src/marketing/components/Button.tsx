import "./Button.css";
import type { ReactNode, MouseEvent } from "react";

type Variant = "primary" | "ghost" | "link";

interface BaseProps {
  children: ReactNode;
  variant?: Variant;
  className?: string;
}

interface AnchorProps extends BaseProps {
  href: string;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

interface ButtonProps extends BaseProps {
  href?: undefined;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  type?: "button" | "submit";
}

export function Button(props: AnchorProps | ButtonProps) {
  const variant: Variant = props.variant ?? "primary";
  const cls = ["mkt-btn", `mkt-btn--${variant}`, props.className].filter(Boolean).join(" ");

  if ("href" in props && props.href !== undefined) {
    return (
      <a href={props.href} onClick={props.onClick} className={cls}>
        {props.children}
      </a>
    );
  }
  return (
    <button type={props.type ?? "button"} onClick={props.onClick} className={cls}>
      {props.children}
    </button>
  );
}
