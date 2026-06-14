import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export interface OptionSelectProps {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  /** Accessible name for the trigger (there's rarely a visible label). */
  ariaLabel: string
  placeholder?: string
  className?: string
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
}: OptionSelectProps) => {
  return (
    <Select value={value} onValueChange={onChange}>
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
