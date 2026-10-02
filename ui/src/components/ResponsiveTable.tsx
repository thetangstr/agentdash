import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { useIsPhone } from "../hooks/useIsPhone";
import { cn } from "../lib/utils";

// AgentDash: mobile redesign — one list pattern for phones.
//
// `MobileList` renders stacked two-line rows (a primary line, a muted
// secondary line, an optional trailing slot) with a 44px minimum row height.
// `ResponsiveTable` renders an ordinary table on desktop and the same rows as
// a `MobileList` on phones, so a page describes its data once.
//
// Breakpoints: "phone" is useIsPhone (narrower than Tailwind `sm`, 640px), the
// same edge as the `max-sm:` classes used here. The bottom nav and the sidebar
// drawer follow SidebarContext's `isMobile` instead (narrower than `md`,
// 768px), so a 700px tablet has the bottom nav but keeps desktop tables.

export interface MobileListRow {
  key: string;
  primary: ReactNode;
  secondary?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  to?: string;
  onClick?: () => void;
}

export function MobileList({
  rows,
  className,
  ariaLabel,
  testId = "mobile-list",
}: {
  rows: MobileListRow[];
  className?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <ul
      data-testid={testId}
      aria-label={ariaLabel}
      className={cn("divide-y divide-border border border-border", className)}
    >
      {rows.map((row) => {
        const body = (
          <>
            {row.leading ? <div className="flex shrink-0 items-center">{row.leading}</div> : null}
            <div className="min-w-0 flex-1">
              <div className="break-words text-sm font-medium leading-snug">{row.primary}</div>
              {row.secondary ? (
                <div className="mt-0.5 line-clamp-2 break-words text-xs leading-snug text-muted-foreground">
                  {row.secondary}
                </div>
              ) : null}
            </div>
            {row.trailing ? (
              <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                {row.trailing}
              </div>
            ) : null}
          </>
        );
        const rowClass = "flex min-h-11 items-center gap-3 px-3 py-2.5";
        return (
          <li key={row.key} data-testid="mobile-list-row">
            {row.to ? (
              <Link
                to={row.to}
                onClick={row.onClick}
                className={cn(rowClass, "text-inherit no-underline transition-colors hover:bg-accent/50")}
              >
                {body}
              </Link>
            ) : row.onClick ? (
              <button
                type="button"
                onClick={row.onClick}
                className={cn(rowClass, "w-full text-left transition-colors hover:bg-accent/50")}
              >
                {body}
              </button>
            ) : (
              <div className={rowClass}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface ResponsiveTableColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Extra classes for both the header and body cells of this column. */
  className?: string;
  align?: "left" | "right";
}

export interface ResponsiveTableProps<T> {
  rows: T[];
  columns: ResponsiveTableColumn<T>[];
  getRowKey: (row: T) => string;
  /** How a row reads on a phone: line one, line two, and an optional trailing slot. */
  mobileRow: (row: T) => Omit<MobileListRow, "key">;
  rowHref?: (row: T) => string | undefined;
  className?: string;
  ariaLabel?: string;
}

export function ResponsiveTable<T>({
  rows,
  columns,
  getRowKey,
  mobileRow,
  rowHref,
  className,
  ariaLabel,
}: ResponsiveTableProps<T>) {
  const isPhone = useIsPhone();

  if (isPhone) {
    return (
      <MobileList
        className={className}
        ariaLabel={ariaLabel}
        rows={rows.map((row) => ({
          key: getRowKey(row),
          to: rowHref?.(row),
          ...mobileRow(row),
        }))}
      />
    );
  }

  return (
    <div className={cn("overflow-x-auto border border-border", className)}>
      <table data-testid="responsive-table" aria-label={ariaLabel} className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "px-4 py-2 font-medium",
                  column.align === "right" && "text-right",
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={getRowKey(row)} className="hover:bg-accent/50">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    "px-4 py-2 align-middle",
                    column.align === "right" && "text-right tabular-nums",
                    column.className,
                  )}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
