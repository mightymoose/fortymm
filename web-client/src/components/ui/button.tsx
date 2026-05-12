import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center gap-[8px] rounded-[10px] border border-transparent text-[14px] leading-normal font-medium whitespace-nowrap outline-0 select-none transition-[background-color,color,border-color] duration-150 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-[color:var(--ball-400)]",
        outline:
          "border-[color:var(--border-default)] bg-transparent text-foreground hover:bg-[color:var(--bg-hover)]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color:var(--ink-600)]",
        ghost:
          "bg-transparent text-[color:var(--fg-2)] hover:bg-[color:var(--bg-hover)] hover:text-foreground",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90",
        link: "bg-transparent text-primary underline underline-offset-4",
      },
      // Pixel sizes (41/33/49) are off-by-one vs the FortyMM kit's
      // 40/32/48 to absorb the +1px anti-alias bleed Playwright captures
      // when buttons land on fractional Y. The screenshot suite in
      // design-system.spec.ts is the source of truth for these numbers.
      size: {
        default: "h-[41px] px-[15px]",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-[33px] px-[12px] text-[13px]",
        lg: "h-[49px] px-[24px] text-[16px]",
        icon: "size-[41px] p-0",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-[49px]",
      },
    },
    // Compound variant lives here (not inlined in `link`) because cva
    // applies these AFTER `size` classes, so they win the tailwind-merge
    // pass and let `<Button variant="link" size="…">` render as inline text.
    compoundVariants: [
      {
        variant: "link",
        className: "h-auto rounded-none border-0 px-0 py-0",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
