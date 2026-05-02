import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-text-primary placeholder:text-text-tertiary selection:bg-accent-200 selection:text-text-primary border-border-soft h-9 w-full min-w-0 rounded-md border bg-surface-raised px-3 py-1 text-base text-text-primary shadow-sm transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-200",
        "aria-invalid:ring-danger-500/20 aria-invalid:border-danger-500",
        className
      )}
      {...props}
    />
  )
}

export { Input }
