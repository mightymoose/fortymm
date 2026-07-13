import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export interface OptionSelectProps {
  value: string
  /** `readonly` so a frozen option table (`PRED_OPS_BY_TYPE`, which is
   * `as const` because its values *are* the `PredicateOp` type) can be handed
   * straight to it. A caller with a narrower value type keeps it: the array is
   * covariant, so the callee reads `string` while the caller still holds its
   * literals — which is what lets `PredicateRow` map this component's raw
   * `string` back to a `PredicateOp`. */
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
  /** Accessible name for the trigger (there's rarely a visible label). */
  ariaLabel: string
  placeholder?: string
  className?: string
  /** A control the organizer may **see** but not **change** — today, a draw type whose
   * fixtures have already been dealt (ADR-0786). It is disabled rather than hidden
   * because the value still matters to them and the reason is worth learning; the
   * caller owes it a visible one in text (the `Field`'s hint), since a disabled trigger
   * can hold no tooltip a screen reader would read. NOT the read-only-viewer case —
   * that renders a value, never a dead control (ADR-0015). */
  disabled?: boolean
}

/** A thin, typed wrapper over the shadcn `Select` for the simple
 * value/options/onChange shape the event-editor forms use. */
export const OptionSelect = ({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  className,
  disabled,
}: OptionSelectProps) => {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
