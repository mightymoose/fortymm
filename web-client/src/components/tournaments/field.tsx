import { useId, type ReactNode } from 'react'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export interface FieldProps {
  label: string
  required?: boolean
  /** Helper or error text shown below the control. */
  hint?: ReactNode
  /** When true, `hint` is rendered as an error (red). */
  error?: boolean
  children: (controlId: string) => ReactNode
  className?: string
}

/** Uppercase-overline label + control + hint, the standard form row used
 * across the tournament forms. `children` receives the generated control id so
 * the rendered input can wire `id`/`aria-describedby`. */
export const Field = ({
  label,
  required,
  hint,
  error,
  children,
  className,
}: FieldProps) => {
  const id = useId()
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label
        htmlFor={id}
        className="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase"
      >
        {label}
        {required && <span className="text-[color:var(--ball-500)]">*</span>}
      </Label>
      {children(id)}
      {hint && (
        <p
          className={cn(
            'text-[11px]',
            error ? 'text-[color:var(--loss)]' : 'text-[color:var(--fg-3)]',
          )}
        >
          {hint}
        </p>
      )}
    </div>
  )
}
