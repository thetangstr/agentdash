import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:ring-2 focus-visible:ring-accent-200 aria-invalid:border-danger-500 transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "bg-accent-100 text-accent-700 border-accent-200 [a&]:hover:bg-accent-200",
        secondary:
          "bg-surface-sunken text-text-secondary border-border-soft [a&]:hover:bg-surface-raised",
        destructive:
          "bg-danger-500/10 text-danger-500 border-danger-500/20 [a&]:hover:bg-danger-500/20",
        outline:
          "border-border-soft text-text-primary [a&]:hover:bg-surface-sunken",
        ghost:
          "border-transparent text-text-secondary [a&]:hover:bg-surface-sunken",
        link: "border-transparent text-accent-500 underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
