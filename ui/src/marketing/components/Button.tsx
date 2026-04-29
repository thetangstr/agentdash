import "./Button.css";
import type { ReactNode, MouseEvent } from "react";

type Variant = "primary" | "ghost" | "link";

interface BaseProps {
  children: ReactNode;
  variant?: Variant;
  className?: string;
  disabled?: boolean;
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
  const disabled = props.disabled ?? false;
  const cls = [
    "mkt-btn",
    `mkt-btn--${variant}`,
    disabled ? "mkt-btn--disabled" : null,
    props.className,
  ].filter(Boolean).join(" ");

  if ("href" in props && props.href !== undefined) {
    return (
      <a
        href={disabled ? undefined : props.href}
        onClick={disabled ? (e) => e.preventDefault() : props.onClick}
        className={cls}
        aria-disabled={disabled || undefined}
      >
        {props.children}
      </a>
    );
  }
  return (
    <button
      type={props.type ?? "button"}
      onClick={props.onClick}
      className={cls}
      disabled={disabled}
    >
      {props.children}
    </button>
  );
}
