import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'

import { ianaTimezones } from './iana-timezones'

export interface TimezoneSelectProps {
  /** The id the `Field`'s label targets (`htmlFor`) — the render-prop `controlId`. */
  id?: string
  /** The currently-selected IANA zone (e.g. `America/Chicago`). */
  value: string
  /** Accessible name for the trigger — there is no visible label of its own; the
   * `Field` above it carries the label text. */
  ariaLabel: string
  /** The id of the row's hint, for `aria-describedby` (a validation message). */
  describedById?: string
  onChange: (timezone: string) => void
}

/**
 * A **searchable IANA timezone picker** — the control the event editor uses to set
 * the zone that anchors an event's wall-clock windows (ADR 20260719). A combobox in
 * the design-system's `Popover` + `Command` shape (`/design-system`): a trigger that
 * shows the current zone, and a filtering list of every zone the runtime knows.
 *
 * The client does **no** timezone arithmetic — it only names the zone and hands it
 * back; the server composes the instants. So this offers *names*, nothing computed
 * from them, which is why it can read the whole list straight off `Intl` rather than
 * carry its own copy of the tz database.
 */
export const TimezoneSelect = ({
  id,
  value,
  ariaLabel,
  describedById,
  onChange,
}: TimezoneSelectProps) => {
  const [open, setOpen] = useState(false)
  const zones = useMemo(() => ianaTimezones(value), [value])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-describedby={describedById}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{value || 'Select a timezone'}</span>
          <ChevronsUpDown size={16} className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput placeholder="Search timezones…" />
          <CommandList>
            <CommandEmpty>No timezone found.</CommandEmpty>
            <CommandGroup>
              {zones.map((tz) => (
                <CommandItem
                  key={tz}
                  value={tz}
                  // cmdk lowercases the value it passes to `onSelect`; close over
                  // the exact IANA name instead, so `America/Chicago` is never
                  // handed back as `america/chicago` (which the server would 422).
                  onSelect={() => {
                    onChange(tz)
                    setOpen(false)
                  }}
                  className="justify-between"
                >
                  {tz}
                  <Check
                    size={16}
                    className={cn(tz === value ? 'opacity-100' : 'opacity-0')}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
