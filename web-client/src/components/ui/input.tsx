import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-[10px] border border-input bg-[color:var(--bg-panel)] px-3 py-0 text-sm text-foreground transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[color:var(--fg-muted)] focus-visible:border-[color:var(--ball-500)] focus-visible:ring-[3px] focus-visible:ring-[color:var(--ball-500)]/15 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[color:var(--loss)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
